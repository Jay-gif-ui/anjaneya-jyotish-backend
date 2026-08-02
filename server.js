import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(express.json());

const allowedOrigins = (process.env.CORS_ORIGIN || "http://127.0.0.1:5500,http://localhost:5500")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`CORS blocked for origin: ${origin}`));
  }
}));

const PORT = process.env.PORT || 3000;
const CASHFREE_ENV = process.env.CASHFREE_ENV || "sandbox";
const CASHFREE_BASE_URL = CASHFREE_ENV === "production" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg";
const API_VERSION = process.env.CASHFREE_API_VERSION || "2025-01-01";
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || "http://localhost:8080";

const SERVICES = {
  kundali: { name: "Kundali Reading & Analysis", amount: 2500 },
  horoscope: { name: "Daily Horoscope", amount: 2 },
  compatibility: { name: "Compatibility Analysis", amount: 299 },
  career: { name: "Career Counseling", amount: 499 }
};

const orders = new Map();

function requireCashfreeKeys() {
  const clientId = (process.env.CASHFREE_CLIENT_ID || "").trim();
  const clientSecret = (process.env.CASHFREE_CLIENT_SECRET || "").trim();

  if (
    !clientId ||
    !clientSecret ||
    clientId === "your_cashfree_client_id" ||
    clientSecret === "your_cashfree_client_secret"
  ) {
    throw new Error("Cashfree API keys are missing. Please add real sandbox/live keys in backend/.env and restart the backend.");
  }
}

function cashfreeHeaders() {
  requireCashfreeKeys();
  return {
    "Content-Type": "application/json",
    "x-client-id": process.env.CASHFREE_CLIENT_ID,
    "x-client-secret": process.env.CASHFREE_CLIENT_SECRET,
    "x-api-version": API_VERSION
  };
}

function makeOrderId() {
  return `AJG_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
}

function validCustomerPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (/^[6-9]\d{9}$/.test(digits)) return digits;
  return "9999999999";
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.post("/api/create-order", async (req, res) => {
  try {
    const { name, email, phone, serviceId, bookingDate, bookingTime } = req.body;
    const service = SERVICES[serviceId];
    if (!name || !email || !service || !bookingDate || !bookingTime) {
      return res.status(400).json({ message: "Invalid booking details" });
    }

    const orderId = makeOrderId();
    const payload = {
      order_id: orderId,
      order_amount: service.amount,
      order_currency: "INR",
      customer_details: {
        customer_id: crypto.createHash("sha256").update(email).digest("hex").slice(0, 20),
        customer_name: name,
        customer_email: email,
        customer_phone: validCustomerPhone(phone)
      },
      order_meta: {
        return_url: `${FRONTEND_BASE_URL}/payment-return.html?order_id={order_id}`
      },
      order_note: `${service.name} | ${bookingDate} ${bookingTime}`
    };

    const cfResponse = await fetch(`${CASHFREE_BASE_URL}/orders`, {
      method: "POST",
      headers: cashfreeHeaders(),
      body: JSON.stringify(payload)
    });
    const cfData = await readJson(cfResponse);
    console.log("Cashfree create order:", cfResponse.status, cfData?.message || cfData?.code || "OK");
    if (!cfResponse.ok) {
      return res.status(502).json({ message: "Cashfree order create failed", details: cfData });
    }

    orders.set(orderId, {
      orderId, customerName: name, customerEmail: email, serviceId, serviceName: service.name, amount: service.amount, bookingDate, bookingTime
    });

    return res.json({
      orderId, paymentSessionId: cfData.payment_session_id, amount: service.amount, serviceName: service.name, mode: CASHFREE_ENV === "production" ? "production" : "sandbox"
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || "Server error" });
  }
});

app.get("/api/verify-payment", async (req, res) => {
  try {
    const orderId = req.query.order_id;
    if (!orderId) return res.status(400).json({ status: "FAILED", message: "Missing order_id" });

    const localOrder = orders.get(orderId);
    const cfResponse = await fetch(`${CASHFREE_BASE_URL}/orders/${encodeURIComponent(orderId)}/payments`, {
      headers: cashfreeHeaders()
    });
    const payments = await readJson(cfResponse);
    if (!cfResponse.ok) {
      return res.status(502).json({ status: "FAILED", message: "Cashfree verification failed", details: payments });
    }

    const successPayment = Array.isArray(payments) ? payments.find((p) => p.payment_status === "SUCCESS") : null;
    if (!successPayment) {
      return res.status(400).json({ status: "FAILED", message: "Payment is not successful" });
    }

    const data = localOrder || { orderId, serviceName: "Consultation", amount: successPayment.order_amount || "", customerName: "", customerEmail: "", bookingDate: "", bookingTime: "" };
    return res.json({
      status: "SUCCESS",
      ...data,
      paymentId: successPayment.cf_payment_id || successPayment.payment_id || successPayment.bank_reference || orderId
    });
  } catch (error) {
    return res.status(500).json({ status: "FAILED", message: error.message || "Server error" });
  }
});

app.post("/api/webhook/cashfree", (req, res) => {
  // Optional: verify Cashfree webhook signature here before trusting payload in production.
  res.json({ received: true });
});

// app.listen(PORT, () => console.log(`Cashfree backend running on port ${PORT}`));
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => {
    console.log(`Cashfree backend running on port ${PORT}`);
  });
}

export default app;