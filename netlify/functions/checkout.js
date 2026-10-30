/*
  OBSYD payment function (Netlify + Stripe Checkout).

  The website sends ONLY which products, sizes, colours and quantities the customer chose,
  plus their address. This function works out every price itself, reading the prices, the sale
  end date, the delivery prices and the free-delivery rule straight from index.html, then asks
  Stripe to create a payment page. A customer can therefore never change a price from their
  browser. Your Stripe secret key lives only in the Netlify environment variable
  STRIPE_SECRET_KEY, never in this file or in index.html.
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STRIPE_LOCALES = ["bg", "cs", "da", "de", "el", "en", "es", "fi", "fr", "hr", "hu", "it", "nb", "nl", "pl", "pt", "ro", "sv"];
const DELIVERY = { fr: "Livraison", en: "Delivery", nl: "Levering", de: "Lieferung", es: "Envío", it: "Spedizione", pt: "Envio", pl: "Dostawa", ro: "Livrare", sv: "Leverans", da: "Levering", nb: "Levering", fi: "Toimitus", el: "Παράδοση", cs: "Doručení", hu: "Szállítás", bg: "Доставка", hr: "Dostava" };
const PROTECTION = { fr: "Protection d’expédition", en: "Shipping protection", nl: "Verzendbescherming", de: "Versandschutz", es: "Protección de envío", it: "Protezione spedizione", pt: "Proteção de envio" };

function loadSite() {
  const candidates = [
    process.env.SITE_FILE,
    path.join(process.env.LAMBDA_TASK_ROOT || "/nonexistent", "index.html"),
    path.join(__dirname, "index.html"),
    path.join(__dirname, "../../index.html"),
    path.join(process.cwd(), "index.html")
  ];
  const file = candidates.find(f => f && fs.existsSync(f));
  if (!file) throw new Error("index.html not found next to the function");
  const html = fs.readFileSync(file, "utf8");
  const grab = re => { const m = html.match(re); if (!m) throw new Error("Cannot read from index.html: " + re); return m[1]; };
  const js = (code, ctx) => vm.runInNewContext("(" + code + ")", ctx || {}, { timeout: 1000 });
  const SIZES = js(grab(/const SIZES = (\[[^\]]*\]);/));
  const PH = js(grab(/const PH = (\{[^\n]*\});/));
  return {
    PROTECTION: Number(grab(/const PROTECTION = ([\d.]+);/)),
    SALE_ENDS: js(grab(/const SALE_ENDS = ("[^"]*"|null);/)),
    COUNTRIES: js(grab(/const COUNTRIES = (\[[^\]]*\]);/)),
    SHIPPING: js(grab(/const SHIPPING = (\{[^}]*\});/)),
    FREE_FROM_ITEMS: Number(grab(/const FREE_FROM_ITEMS = (\d+);/)),
    SIZES,
    PRODUCTS: js(grab(/const PRODUCTS = (\[[\s\S]*?\n\]);/), { PH, SIZES, IMG: new Proxy({}, { get: () => "" }) })
  };
}

const reply = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const fail = (statusCode, error) => reply(statusCode, { error });
const nm = v => typeof v === "string" ? v : (v && (v.fr || v.en)) || "";
const clean = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

exports.handler = async event => {
  if (event.httpMethod !== "POST") return fail(405, "POST only");
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return fail(500, "STRIPE_SECRET_KEY is not set in Netlify");

  let site, body;
  try { site = loadSite(); } catch (e) { console.error(e); return fail(500, "Cannot read the shop settings"); }
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return fail(400, "Invalid request"); }

  // ---- customer
  const c = body.customer || {};
  const customer = {
    email: clean(c.email, 200), phone: clean(c.phone, 40),
    first: clean(c.first_name, 80), last: clean(c.last_name, 80),
    street: clean(c.street, 200), postal: clean(c.postal_code, 20), city: clean(c.city, 100), country: clean(c.country, 2).toUpperCase()
  };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) return fail(400, "Invalid email");
  if (!customer.first || !customer.last || !customer.street || !customer.postal || !customer.city) return fail(400, "Address is incomplete");
  if (!site.COUNTRIES.includes(customer.country)) return fail(400, "We do not deliver to this country");

  // ---- cart, priced from index.html only
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length || items.length > 30) return fail(400, "Invalid cart");
  const saleOn = !site.SALE_ENDS || Date.now() < new Date(site.SALE_ENDS).getTime();
  const lines = [];
  let count = 0;
  for (const it of items) {
    const p = site.PRODUCTS[it && it.i];
    if (!p) return fail(400, "Unknown product");
    if (!(p.sizes || site.SIZES).includes(it.size)) return fail(400, "Unknown size");
    let colour = "";
    if (p.colors) { const k = p.colors[it.c == null ? 0 : it.c]; if (!k) return fail(400, "Unknown colour"); colour = nm(k.name); }
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) return fail(400, "Invalid quantity");
    const onSale = saleOn && p.salePrice != null && p.salePrice !== "" && p.salePrice < p.price;
    lines.push({ name: [nm(p.name), colour, it.size].filter(Boolean).join(" · "), cents: Math.round((onSale ? p.salePrice : p.price) * 100), qty });
    count += qty;
  }
  const lang = STRIPE_LOCALES.includes(body.lang) ? body.lang : "fr";
  if (body.protection) lines.push({ name: PROTECTION[lang] || PROTECTION.en, cents: Math.round(site.PROTECTION * 100), qty: 1 });
  const delivery = count >= site.FREE_FROM_ITEMS ? 0 : (customer.country in site.SHIPPING ? site.SHIPPING[customer.country] : site.SHIPPING.other);
  if (delivery > 0) lines.push({ name: DELIVERY[lang] || DELIVERY.en, cents: Math.round(delivery * 100), qty: 1 });

  // ---- ask Stripe for a payment page
  const origin = process.env.URL || (event.headers && event.headers.origin);
  if (!origin) return fail(500, "Site address unknown");
  const summary = lines.map(l => l.qty + "x " + l.name).join("; ").slice(0, 480);
  const f = new URLSearchParams();
  f.set("mode", "payment");
  f.set("success_url", origin + "/?paid=1");
  f.set("cancel_url", origin + "/");
  f.set("customer_email", customer.email);
  f.set("locale", lang);
  lines.forEach((l, n) => {
    f.set(`line_items[${n}][quantity]`, String(l.qty));
    f.set(`line_items[${n}][price_data][currency]`, "eur");
    f.set(`line_items[${n}][price_data][unit_amount]`, String(l.cents));
    f.set(`line_items[${n}][price_data][product_data][name]`, l.name);
  });
  f.set("payment_intent_data[shipping][name]", customer.first + " " + customer.last);
  f.set("payment_intent_data[shipping][address][line1]", customer.street);
  f.set("payment_intent_data[shipping][address][city]", customer.city);
  f.set("payment_intent_data[shipping][address][postal_code]", customer.postal);
  f.set("payment_intent_data[shipping][address][country]", customer.country);
  if (customer.phone) f.set("payment_intent_data[shipping][phone]", customer.phone);
  for (const pre of ["metadata", "payment_intent_data[metadata]"]) {
    f.set(pre + "[order]", summary);
    f.set(pre + "[email]", customer.email);
    f.set(pre + "[phone]", customer.phone);
    f.set(pre + "[language]", lang);
  }

  try {
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/x-www-form-urlencoded" },
      body: f.toString()
    });
    const data = await res.json();
    if (!res.ok || !data.url) { console.error("Stripe error", res.status, JSON.stringify(data)); return fail(502, "Payment could not be started"); }
    return reply(200, { url: data.url });
  } catch (e) {
    console.error(e);
    return fail(502, "Payment could not be started");
  }
};
