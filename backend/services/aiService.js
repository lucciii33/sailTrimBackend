const OpenAI = require("openai");

let _openai = null;
function getOpenAI() {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPEN_IA || process.env.OPENAI_API_KEY });
  }
  return _openai;
}

async function generateTestCases(diff) {
  const completion = await getOpenAI().chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content:
          "You are a QA engineer. Given a code diff, generate thorough API test cases in markdown format. For each endpoint changed, provide test cases covering: happy path, edge cases, and invalid inputs. Be concise and actionable.",
      },
      {
        role: "user",
        content: `Generate API test cases for the following code diff:\n\n${diff}`,
      },
    ],
  });

  return completion.choices[0].message.content;
}

module.exports = { generateTestCases };
