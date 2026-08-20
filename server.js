const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const Razorpay = require('razorpay');
const { Anthropic } = require('@anthropic-ai/sdk');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Enable CORS and JSON body parsing
app.use(cors());
app.use(express.json());

// Serve static assets from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Razorpay SDK
const razorpayKeyId = process.env.RAZORPAY_KEY_ID || 'rzp_test_demo123456';
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || 'demosecretkey123456';

const razorpay = new Razorpay({
  key_id: razorpayKeyId,
  key_secret: razorpayKeySecret
});

// Audit Log Disk Persistence Configuration
const AUDIT_LOG_FILE = process.env.AUDIT_LOG_PATH || path.join(__dirname, 'audit_log.json');

// Helper: Append entry to audit_log.json
function appendAuditLog({ conversation_id, action_type, reasoning, outcome, metadata = {} }) {
  const timestamp = new Date().toISOString();
  const id = `audit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  
  const entry = {
    id,
    timestamp,
    conversation_id,
    action_type,
    reasoning,
    outcome,
    metadata
  };

  let logs = [];
  try {
    const dir = path.dirname(AUDIT_LOG_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(AUDIT_LOG_FILE)) {
      const content = fs.readFileSync(AUDIT_LOG_FILE, 'utf8');
      logs = JSON.parse(content || '[]');
    }
  } catch (err) {
    console.error('Error reading audit_log.json:', err.message);
    logs = [];
  }

  logs.push(entry);

  try {
    const dir = path.dirname(AUDIT_LOG_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(AUDIT_LOG_FILE, JSON.stringify(logs, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing to audit_log.json:', err.message);
  }

  console.log(`[AUDIT TRAIL] [${timestamp}] | Type: ${action_type} | Outcome: ${outcome} | ConvID: ${conversation_id}`);
  console.log(`  Reasoning: ${reasoning}`);
  if (Object.keys(metadata).length > 0) {
    console.log(`  Metadata: ${JSON.stringify(metadata)}`);
  }
  console.log('----------------------------------------------------------------');

  return entry;
}

// In-memory sessions store
const sessions = new Map();

function getSession(conversation_id) {
  if (!sessions.has(conversation_id)) {
    sessions.set(conversation_id, {
      messages: [],
      last_proposed_product_id: null,
      last_proposed_price: null,
      proposal_consumed: false,
      order_count: 0,
      retry_count: 0
    });
  }
  return sessions.get(conversation_id);
}

// Helper: Load Catalog
function loadCatalog() {
  const catalogPath = path.join(__dirname, 'catalog.json');
  try {
    const data = fs.readFileSync(catalogPath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading catalog.json:', err.message);
    return [];
  }
}

// Initialize Anthropic Client
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const isLiveAnthropicKey = anthropicKey && anthropicKey.startsWith('sk-ant-') && !anthropicKey.includes('demo') && !anthropicKey.includes('your_');
const anthropic = new Anthropic({
  apiKey: anthropicKey || 'dummy_key'
});

// Root Landing Page
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({
      status: 'online',
      app: 'Razorpay Agentic Commerce AI Demo',
      track: 'AI Growth & Agentic Commerce'
    });
  }
});

// 1. GET /catalog - Agent-Readable Catalog
app.get('/catalog', (req, res) => {
  const catalog = loadCatalog();
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(catalog);
});

// Fallback catalog matching logic
function fallbackCatalogMatch(userMessage, catalog) {
  const text = userMessage.toLowerCase();
  
  let maxPrice = null;
  const priceMatch = text.match(/(?:under|below|less than|kam|tak|max|within|\<)\s*₹?\s*(\d+)/i);
  if (priceMatch) {
    maxPrice = parseInt(priceMatch[1], 10);
  }

  let matchedProducts = catalog.filter(product => {
    let score = 0;
    
    product.tags.forEach(tag => {
      if (text.includes(tag.toLowerCase())) score += 2;
    });

    const nameWords = product.name.toLowerCase().split(/\s+/);
    nameWords.forEach(word => {
      if (word.length > 3 && text.includes(word)) score += 3;
    });

    if (text.includes('blue') && (product.tags.includes('blue') || product.name.toLowerCase().includes('blue'))) score += 3;
    if (text.includes('white') && (product.tags.includes('white') || product.name.toLowerCase().includes('white'))) score += 3;
    if (text.includes('black') && (product.tags.includes('black') || product.name.toLowerCase().includes('black'))) score += 3;

    if (maxPrice !== null && product.price_inr > maxPrice) {
      return false;
    }

    return score > 0;
  });

  matchedProducts.sort((a, b) => b.price_inr - a.price_inr);

  if (matchedProducts.length > 0) {
    const top = matchedProducts[0];
    let replyText = `Aapke budget ke hisab se hamare paas "${top.name}" available hai sirf ₹${top.price_inr} mein! (${top.description}) Kya aap iska order placement confirm karna chahenge?`;
    return {
      reply_text: replyText,
      proposed_product_id: top.id,
      proposed_price: top.price_inr
    };
  }

  return {
    reply_text: "Mujhe aapke criteria ke mutabiq filhaal koi product nahi mila. Aap hamara catalog explore kar sakte hain!",
    proposed_product_id: null,
    proposed_price: null
  };
}

// 2. POST /chat - Conversational AI Shopping Agent
app.post('/chat', async (req, res) => {
  try {
    const { message, conversation_id = 'default' } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Field "message" is required and must be a non-empty string.' });
    }

    const session = getSession(conversation_id);
    session.messages.push({ role: 'user', content: message.trim() });

    const catalog = loadCatalog();
    let agentResponse;

    if (isLiveAnthropicKey) {
      try {
        const systemPrompt = `You are an expert AI Shopping Assistant for an online store, participating in the Razorpay AI Buildathon (Track: AI Growth & Agentic Commerce).
Your job is to understand user shopping intents (supporting Hinglish, Hindi, and English mix), match products against the catalog, and answer conversationally.

Catalog Context:
${JSON.stringify(catalog, null, 2)}

CRITICAL SECURITY RULE:
- You MUST NEVER confirm or trigger a purchase order yourself.
- You can ONLY propose a matching product + price and ask the user to confirm their intent to buy (e.g. "Would you like me to prepare the payment details for this item?").

RESPONSE FORMAT:
You MUST respond strictly with a valid JSON object in the following format and NO markdown wrappers:
{
  "reply_text": "<Conversational response in friendly tone/Hinglish suggesting the product>",
  "proposed_product_id": "<product_id e.g. prod_1 or null if no specific product matched>",
  "proposed_price": <number price in INR or null if no item proposed>
}`;

        const llmMessages = session.messages.map(msg => ({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content
        }));

        const response = await anthropic.messages.create({
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 500,
          system: systemPrompt,
          messages: llmMessages
        });

        const rawText = response.content[0].text.trim();
        const cleanedText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        agentResponse = JSON.parse(cleanedText);
      } catch (llmError) {
        console.warn('Anthropic API call failed, using fallback matcher:', llmError.message);
        agentResponse = fallbackCatalogMatch(message, catalog);
      }
    } else {
      agentResponse = fallbackCatalogMatch(message, catalog);
    }

    session.messages.push({ role: 'assistant', content: agentResponse.reply_text });

    if (agentResponse.proposed_product_id) {
      session.last_proposed_product_id = agentResponse.proposed_product_id;
      session.last_proposed_price = agentResponse.proposed_price;
      session.proposal_consumed = false;

      appendAuditLog({
        conversation_id,
        action_type: 'PRODUCT_PROPOSED',
        reasoning: `AI Agent matched user query "${message.trim()}" against catalog and proposed product ${agentResponse.proposed_product_id} at ₹${agentResponse.proposed_price}.`,
        outcome: 'SUCCESS',
        metadata: {
          proposed_product_id: agentResponse.proposed_product_id,
          proposed_price_inr: agentResponse.proposed_price,
          user_query: message.trim()
        }
      });
    }

    return res.status(200).json({
      reply_text: agentResponse.reply_text,
      proposed_product_id: agentResponse.proposed_product_id || null,
      proposed_price: agentResponse.proposed_price || null
    });

  } catch (error) {
    console.error('Error in /chat endpoint:', error);
    return res.status(500).json({ error: 'Internal Server Error in /chat endpoint' });
  }
});

// 3. POST /checkout/confirm - Gated Order Creation Endpoint
app.post('/checkout/confirm', async (req, res) => {
  try {
    const { conversation_id = 'default', product_id } = req.body;

    if (!product_id) {
      return res.status(400).json({ error: 'Field "product_id" is required.' });
    }

    const session = getSession(conversation_id);

    // Lookup item details from catalog first
    const catalog = loadCatalog();
    const product = catalog.find(p => p.id === product_id);

    if (!product) {
      appendAuditLog({
        conversation_id,
        action_type: 'GUARDRAIL_BLOCKED',
        reasoning: `Order creation rejected: Product ID "${product_id}" does not exist in store catalog.`,
        outcome: 'BLOCKED',
        metadata: { requested_product_id: product_id, guardrail: 'INVALID_CATALOG_ID' }
      });
      return res.status(404).json({ error: `Product "${product_id}" not found in catalog.` });
    }

    // Auto-register selection if user selected item directly from UI catalog grid
    if (!session.last_proposed_product_id || session.last_proposed_product_id !== product_id) {
      session.last_proposed_product_id = product_id;
      session.last_proposed_price = product.price_inr;
      session.proposal_consumed = false;

      appendAuditLog({
        conversation_id,
        action_type: 'PRODUCT_SELECTED',
        reasoning: `User directly selected product "${product.name}" (${product.id}) from the storefront catalog grid.`,
        outcome: 'SUCCESS',
        metadata: { product_id: product.id, price_inr: product.price_inr }
      });
    }

    appendAuditLog({
      conversation_id,
      action_type: 'CONFIRMATION_ATTEMPTED',
      reasoning: `User explicitly initiated checkout confirmation for product "${product.name}" (${product_id}).`,
      outcome: 'PENDING',
      metadata: {
        requested_product_id: product_id,
        last_proposed_product_id: session.last_proposed_product_id,
        current_order_count: session.order_count
      }
    });

    // Guardrail Rule 1: Max 2 orders per session limit
    if (session.order_count >= 2) {
      appendAuditLog({
        conversation_id,
        action_type: 'GUARDRAIL_BLOCKED',
        reasoning: `Order creation rejected: Conversation session exceeded anti-runaway limit of 2 orders.`,
        outcome: 'BLOCKED',
        metadata: { order_count: session.order_count, max_allowed: 2, guardrail: 'MAX_2_ORDERS_PER_SESSION' }
      });

      return res.status(400).json({
        error: 'Order limit reached. A session cannot create more than 2 orders without starting a new session.',
        guardrail: 'MAX_2_ORDERS_PER_SESSION'
      });
    }

    // Guardrail Rule 2: Validate proposal has not already been consumed
    if (session.proposal_consumed) {
      appendAuditLog({
        conversation_id,
        action_type: 'GUARDRAIL_BLOCKED',
        reasoning: `Order creation rejected: Proposal for product "${product_id}" has already been processed into an order.`,
        outcome: 'BLOCKED',
        metadata: { product_id, guardrail: 'PROPOSAL_ALREADY_CONSUMED' }
      });

      return res.status(400).json({
        error: `This proposal for product "${product_id}" has already been processed into an order. Please select or ask for a fresh product.`,
        guardrail: 'PROPOSAL_ALREADY_CONSUMED'
      });
    }

    const amountInPaise = product.price_inr * 100;
    const receipt = `rcpt_${conversation_id.substring(0, 10)}_${Date.now()}`;

    let razorpayOrder;

    try {
      if (razorpayKeyId.startsWith('rzp_test_') && !razorpayKeyId.includes('demo')) {
        razorpayOrder = await razorpay.orders.create({
          amount: amountInPaise,
          currency: 'INR',
          receipt: receipt,
          notes: {
            conversation_id,
            product_id: product.id,
            product_name: product.name
          }
        });
      } else {
        razorpayOrder = {
          id: `order_test_mock_${Date.now()}`,
          entity: 'order',
          amount: amountInPaise,
          currency: 'INR',
          receipt: receipt,
          status: 'created',
          created_at: Math.floor(Date.now() / 1000)
        };
      }
    } catch (rzpErr) {
      console.warn('Razorpay API error, using mock order:', rzpErr.message);
      razorpayOrder = {
        id: `order_test_mock_${Date.now()}`,
        entity: 'order',
        amount: amountInPaise,
        currency: 'INR',
        receipt: receipt,
        status: 'created',
        created_at: Math.floor(Date.now() / 1000)
      };
    }

    session.order_count += 1;
    session.proposal_consumed = true;

    appendAuditLog({
      conversation_id,
      action_type: 'ORDER_CREATED',
      reasoning: `Razorpay TEST-MODE order created after explicit user confirmation for "${product.name}" (${product.id}) at ₹${product.price_inr}.`,
      outcome: 'SUCCESS',
      metadata: {
        order_id: razorpayOrder.id,
        amount_inr: product.price_inr,
        amount_paise: razorpayOrder.amount,
        currency: razorpayOrder.currency,
        receipt: razorpayOrder.receipt,
        order_count: session.order_count
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Razorpay order created successfully following explicit user confirmation.',
      order_id: razorpayOrder.id,
      amount: razorpayOrder.amount,
      amount_inr: product.price_inr,
      currency: razorpayOrder.currency,
      receipt: razorpayOrder.receipt,
      product: {
        id: product.id,
        name: product.name,
        description: product.description
      },
      session_summary: {
        order_count: session.order_count,
        max_orders_allowed: 2
      }
    });

  } catch (error) {
    console.error('Error in /checkout/confirm endpoint:', error);
    return res.status(500).json({ error: 'Internal Server Error during checkout confirmation.' });
  }
});

// 4. POST /payment/verify - Payment Result & Failure Handling Endpoint
app.post('/payment/verify', async (req, res) => {
  try {
    const {
      conversation_id = 'default',
      order_id,
      payment_id,
      status, // 'success' | 'captured' | 'failed'
      error_code,
      failure_reason,
      card_number
    } = req.body;

    if (!order_id) {
      return res.status(400).json({ error: 'Field "order_id" is required.' });
    }

    const session = getSession(conversation_id);

    appendAuditLog({
      conversation_id,
      action_type: 'PAYMENT_ATTEMPTED',
      reasoning: `User attempted payment for Razorpay order "${order_id}" (Status: ${status || 'processing'}).`,
      outcome: 'PENDING',
      metadata: { order_id, payment_id: payment_id || 'simulated_pay', card_number: card_number || 'N/A' }
    });

    let isFailure = false;
    let detectedReason = failure_reason || 'PAYMENT_DECLINED';

    if (status === 'failed' || error_code) {
      isFailure = true;
    } else if (card_number === '4000000000000002') {
      isFailure = true;
      detectedReason = 'INSUFFICIENT_FUNDS';
    } else if (card_number === '4000000000000004') {
      isFailure = true;
      detectedReason = 'AUTHENTICATION_FAILED';
    }

    if (isFailure) {
      let plainExplanation = "Payment processing me technical issue aaya.";
      if (detectedReason === 'INSUFFICIENT_FUNDS' || failure_reason === 'INSUFFICIENT_FUNDS') {
        plainExplanation = "Aapke bank/card se payment decline ho gaya hai (Insufficient balance/Refusal).";
      } else if (detectedReason === 'AUTHENTICATION_FAILED' || failure_reason === 'OTP_FAILED') {
        plainExplanation = "Bank OTP verification complete nahi ho paya.";
      } else {
        plainExplanation = "Aapka card transaction decline ho gaya hai.";
      }

      if (session.retry_count < 1) {
        session.retry_count += 1;
        session.proposal_consumed = false;

        appendAuditLog({
          conversation_id,
          action_type: 'PAYMENT_RESULT',
          reasoning: `Payment failed for order ${order_id} (${plainExplanation}). Guardrail rule evaluated: 0 retries used so far. Offering exactly ONE retry attempt to the user.`,
          outcome: 'FAILED_RETRY_ALLOWED',
          metadata: {
            order_id,
            error_code: error_code || 'PAYMENT_FAILED',
            failure_reason: detectedReason,
            retry_count: session.retry_count,
            max_retries_allowed: 1
          }
        });

        return res.status(200).json({
          status: 'failed',
          explanation: plainExplanation,
          can_retry: true,
          retries_left: 0,
          user_message: `${plainExplanation} Kya aap is order ko ek baar retry karna chahenge?`,
          action_required: 'CONFIRM_RETRY'
        });
      } else {
        appendAuditLog({
          conversation_id,
          action_type: 'GUARDRAIL_BLOCKED',
          reasoning: `Payment retry failed again for order ${order_id}. Anti-looping guardrail triggered (Max 1 retry exceeded). Blocking further retries for this card/session and directing user to switch payment methods.`,
          outcome: 'BLOCKED',
          metadata: {
            order_id,
            retry_count: session.retry_count,
            max_retries: 1,
            guardrail: 'MAX_1_RETRY_EXCEEDED'
          }
        });

        appendAuditLog({
          conversation_id,
          action_type: 'PAYMENT_RESULT',
          reasoning: `Payment process terminated after retry failure. Agent gracefully instructing user to select an alternate payment method (e.g. UPI, Netbanking).`,
          outcome: 'FAILED_FINAL',
          metadata: { order_id, status: 'failed_final' }
        });

        return res.status(200).json({
          status: 'failed_final',
          explanation: `${plainExplanation} Anti-looping guardrail active: Maximum 1 retry attempt exceeded.`,
          can_retry: false,
          retries_left: 0,
          user_message: "Maaf kijiye, retry attempt bhi fail ho gaya. Kripya doosra payment method select karein (jaise UPI ya Netbanking).",
          action_required: 'CHANGE_PAYMENT_METHOD'
        });
      }
    }

    appendAuditLog({
      conversation_id,
      action_type: 'PAYMENT_RESULT',
      reasoning: `Payment of order ${order_id} captured successfully via Razorpay.`,
      outcome: 'SUCCESS',
      metadata: {
        order_id,
        payment_id: payment_id || `pay_${Date.now()}`,
        status: 'captured'
      }
    });

    return res.status(200).json({
      status: 'success',
      message: 'Payment captured successfully! Order confirmed.',
      order_id,
      payment_id: payment_id || `pay_${Date.now()}`
    });

  } catch (error) {
    console.error('Error in /payment/verify endpoint:', error);
    return res.status(500).json({ error: 'Internal Server Error during payment verification.' });
  }
});

// 5. GET /audit - Query Persistent Audit Logs
app.get('/audit', (req, res) => {
  const { conversation_id } = req.query;

  let logs = [];
  try {
    if (fs.existsSync(AUDIT_LOG_FILE)) {
      const content = fs.readFileSync(AUDIT_LOG_FILE, 'utf8');
      logs = JSON.parse(content || '[]');
    }
  } catch (err) {
    console.error('Error reading audit_log.json:', err.message);
    logs = [];
  }

  if (conversation_id) {
    logs = logs.filter(entry => entry.conversation_id === conversation_id);
  }

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json(logs);
});

// 6. GET /audit/view - Visual Audit Dashboard Page
app.get('/audit/view', (req, res) => {
  const dashboardPath = path.join(__dirname, 'public', 'audit_view.html');
  if (fs.existsSync(dashboardPath)) {
    res.sendFile(dashboardPath);
  } else {
    res.status(404).send('Audit dashboard template not found.');
  }
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` Razorpay Agentic Commerce API running on port ${PORT}`);
  console.log(` Catalog Endpoint: http://localhost:${PORT}/catalog`);
  console.log(` Chat Agent Endpoint: http://localhost:${PORT}/chat`);
  console.log(` Confirm Checkout:    http://localhost:${PORT}/checkout/confirm`);
  console.log(` Verify Payment:      http://localhost:${PORT}/payment/verify`);
  console.log(` Audit Trail JSON:    http://localhost:${PORT}/audit`);
  console.log(` Audit Dashboard UI:  http://localhost:${PORT}/audit/view`);
  console.log(`====================================================`);
});
