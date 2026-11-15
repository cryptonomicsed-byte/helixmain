//! Example plugin: pricing. Two tools.
//!
//!   quote     {items:[{sku, qty, unit_price_minor}], currency}  ->  {subtotal_minor, discount_minor, total_minor, currency, lines}
//!   checkout  the same input                                    ->  the quote, plus a PROPOSED merchant.order intent
//!
//! It computes and it proposes. It cannot charge anyone: the kernel decides
//! whether the proposed order may happen, and a person confirms the money.

wit_bindgen::generate!({ path: "../../wit", world: "plugin" });

use exports::helix::plugin::tool::{Guest, Output, ToolInfo};
use helix::plugin::host;
use serde_json::{json, Value};

struct Pricing;

fn parse(input: &str) -> Result<(Vec<(String, i64, i64)>, String), String> {
    let v: Value = serde_json::from_str(input).map_err(|e| format!("input is not JSON: {e}"))?;
    let currency = v["currency"].as_str().ok_or("currency is required")?.to_string();
    if currency.len() != 3 || !currency.chars().all(|c| c.is_ascii_uppercase()) {
        return Err("currency must be a 3-letter ISO code".into());
    }
    let items = v["items"].as_array().ok_or("items must be a list")?;
    if items.is_empty() || items.len() > 200 {
        return Err("items must have between 1 and 200 lines".into());
    }
    let mut lines = vec![];
    for (i, it) in items.iter().enumerate() {
        let sku = it["sku"].as_str().ok_or(format!("items[{i}].sku is required"))?.to_string();
        let qty = it["qty"].as_i64().filter(|q| (1..=10_000).contains(q)).ok_or(format!("items[{i}].qty must be 1..10000"))?;
        let price = it["unit_price_minor"].as_i64().filter(|p| (0..=100_000_000).contains(p)).ok_or(format!("items[{i}].unit_price_minor must be 0..100000000"))?;
        lines.push((sku, qty, price));
    }
    Ok((lines, currency))
}

/// 5% off from 10 units of a line, 10% off from 50.
fn line_discount(qty: i64, subtotal: i64) -> i64 {
    match qty {
        50.. => subtotal / 10,
        10..=49 => subtotal / 20,
        _ => 0,
    }
}

fn quote(input: &str) -> Result<Value, String> {
    let (lines, currency) = parse(input)?;
    let (mut subtotal, mut discount) = (0i64, 0i64);
    let mut out = vec![];
    for (sku, qty, price) in lines {
        let line = qty.checked_mul(price).ok_or("line total overflows")?;
        let d = line_discount(qty, line);
        subtotal = subtotal.checked_add(line).ok_or("subtotal overflows")?;
        discount += d;
        out.push(json!({"sku": sku, "qty": qty, "line_minor": line, "discount_minor": d}));
    }
    Ok(json!({"subtotal_minor": subtotal, "discount_minor": discount, "total_minor": subtotal - discount, "currency": currency, "lines": out}))
}

impl Guest for Pricing {
    fn list_tools() -> Vec<ToolInfo> {
        vec![
            ToolInfo { name: "quote".into(), description: "Price a basket with quantity discounts. Pure computation.".into() },
            ToolInfo { name: "checkout".into(), description: "Quote a basket and PROPOSE the order. Nothing is purchased.".into() },
        ]
    }

    fn invoke(tool: String, input_json: String) -> Result<Output, String> {
        match tool.as_str() {
            "quote" => {
                let q = quote(&input_json)?;
                host::log("info", &format!("quoted {} {}", q["total_minor"], q["currency"]));
                Ok(Output { result_json: q.to_string(), proposed_intents: vec![] })
            }
            "checkout" => {
                let q = quote(&input_json)?;
                // remember the last total so a later call can detect a changed basket
                let total = q["total_minor"].as_i64().unwrap_or(0).to_string();
                let _ = host::kv_set("last_total", &total);
                let intent = json!({
                    "capability": "merchant.order", "tool": "merchant.checkout", "target": "merchant:basket",
                    "operation": "order.create", "risk": "medium",
                    "arguments": {"lines": q["lines"]},
                    "amount_minor": q["total_minor"], "currency": q["currency"],
                });
                Ok(Output { result_json: q.to_string(), proposed_intents: vec![intent.to_string()] })
            }
            other => Err(format!("no such tool: {other}")),
        }
    }
}

export!(Pricing);
