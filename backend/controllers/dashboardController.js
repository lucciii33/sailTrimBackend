const { Configuration, OpenAIApi } = require('openai');
const OpenAI = require("openai");
const { parse, stringify } = require('flatted'); 
// const configuration = new Configuration({
//     apiKey: "sk-proj-Fwc8MxeXaCJuDr7Rlx1AT3BlbkFJmYQFNyeTqkbXYFyNyewt",
// });

// const openai = new OpenAIApi(configuration);

const openai = new OpenAI({ apiKey: "sk-proj-Fwc8MxeXaCJuDr7Rlx1AT3BlbkFJmYQFNyeTqkbXYFyNyewt" });

async function generateText(prompt) {
    try {
        const message = {
            role: "system",
            content: prompt
        };

        const messageString = stringify({
            role: message.role,
            content: message.content
        }); 

        const completion = await openai.chat.completions.create({
            messages: [{
                role: "system",
                content: messageString
            }],
            model: "gpt-3.5-turbo",
        });

        return completion.choices[0];
    } catch (error) {
        console.error("Error generating text:", error);
        return "An error occurred while generating text.";
    }
}

module.exports = {
    generateText,
}