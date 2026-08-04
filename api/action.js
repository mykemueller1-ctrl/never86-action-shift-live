const ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "owner",
    "owner_initials",
    "action",
    "coach_card",
    "why_now",
    "proof_required",
    "verification_rule"
  ],
  properties: {
    owner: { type: "string", minLength: 2, maxLength: 80 },
    owner_initials: { type: "string", minLength: 1, maxLength: 4 },
    action: { type: "string", minLength: 20, maxLength: 400 },
    coach_card: { type: "string", minLength: 20, maxLength: 400 },
    why_now: { type: "string", minLength: 20, maxLength: 300 },
    proof_required: { type: "string", minLength: 10, maxLength: 300 },
    verification_rule: { type: "string", minLength: 20, maxLength: 350 }
  }
};

function clean(value, max = 500) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function normalizeSignal(body) {
  return {
    location: clean(body.location, 100),
    signal: clean(body.signal, 140),
    current_rate: clean(body.current_rate, 40),
    baseline_rate: clean(body.baseline_rate, 40),
    current_label: clean(body.current_label, 100),
    baseline_label: clean(body.baseline_label, 100),
    net_sales: clean(body.net_sales, 40),
    leak_amount: clean(body.leak_amount, 40),
    orders: clean(body.orders, 40),
    opportunity: clean(body.opportunity, 40),
    source: clean(body.source, 220),
    owner: clean(body.owner, 80),
    deadline: clean(body.deadline, 120)
  };
}

function isValidSignal(signal) {
  return signal.location && signal.signal && signal.source;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: "OPENAI_API_KEY is not configured" });
  }

  const signal = normalizeSignal(req.body || {});
  if (!isValidSignal(signal)) {
    return res.status(400).json({ error: "A location, signal, and source are required" });
  }

  const model = process.env.OPENAI_MODEL || "gpt-5";
  const instructions = [
    "You are Never86'd, a restaurant operator decision engine.",
    "Turn one verified restaurant signal into one practical frontline action.",
    "Do not accuse theft, fraud, or misconduct. Treat anomalies as process exceptions requiring verification.",
    "Do not invent facts, people, savings, dates, or evidence.",
    "Use the supplied owner and deadline when reasonable.",
    "Every action must identify proof and a measurable verification rule.",
    "Keep language direct, operator-safe, and usable during the next shift."
  ].join(" ");

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        store: false,
        instructions,
        input: `Create an Action Shift card from this source-stamped signal:\n${JSON.stringify(signal, null, 2)}`,
        text: {
          format: {
            type: "json_schema",
            name: "action_shift_card",
            strict: true,
            schema: ACTION_SCHEMA
          }
        }
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      console.error("OpenAI API error", response.status, payload?.error?.code || "unknown");
      return res.status(502).json({ error: "The decision engine is temporarily unavailable" });
    }

    const text = payload.output_text || payload.output?.flatMap(item => item.content || []).find(item => item.type === "output_text")?.text;
    if (!text) {
      return res.status(502).json({ error: "The decision engine returned no usable card" });
    }

    const card = JSON.parse(text);
    return res.status(200).json({
      ...card,
      source: "GPT-5.6",
      model: payload.model || model
    });
  } catch (error) {
    console.error("Action Shift failure", error instanceof Error ? error.message : "unknown");
    return res.status(500).json({ error: "Unable to generate the action card" });
  }
}
