const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPEN_IA,
});

async function generateTestCases(diff) {
  const completion = await openai.chat.completions.create({
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
