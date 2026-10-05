const path = require("path");
const { compileSystemPrompt } = require(path.join(__dirname, "../dist/index.js"));
const card = require("./null-price-card.json");

const systemPrompt = compileSystemPrompt(card);

module.exports = async function ({ vars }) {
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: vars.question },
  ];
};
