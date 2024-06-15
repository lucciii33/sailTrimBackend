const { Configuration, OpenAIApi } = require('openai');
const OpenAI = require("openai");
const { parse, stringify } = require('flatted'); 
const { GoogleGenerativeAI } = require("@google/generative-ai");
const apiKey = process.env.GEMINI_KEY; // Replace with your actual key

const genAI = new GoogleGenerativeAI("AIzaSyDa3W2MKxBBjxnjCp6cJfHO8iJcn55B4v4");

// const openai = new OpenAI({ apiKey: "sk-proj-Fwc8MxeXaCJuDr7Rlx1AT3BlbkFJmYQFNyeTqkbXYFyNyewt" });

async function generateTextGoole(req, res) {
    const { prompt } = req.body;
    if (!prompt) {
        return res.status(400).send("Prompt is required.");
    }
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash"});
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        console.log(text);
        res.status(200).json({ generatedText: text });
    } catch (error) {
        console.error("Error generating text:", error);
        return "An error occurred while generating text.";
    }
}

async function generateTestQuestions(req, res) {
    const { topic } = req.body;
    if (!topic) {
        return res.status(400).send("Topic is required.");
    }

    const prompt = `Generate test questions for the topic: ${topic}.`;

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = await response.text();
        
        // Assuming the response is a list of questions, split them accordingly
        const questions = text.split('\n').filter(question => question.trim() !== '');

        console.log(questions);
        res.status(200).json({ generatedQuestions: questions });
    } catch (error) {
        console.error("Error generating questions:", error);
        res.status(500).send("An error occurred while generating questions.");
    }
}

// async function generateText(prompt) {
//     try {
//         const message = {
//             role: "system",
//             content: prompt
//         };

//         const messageString = stringify({
//             role: message.role,
//             content: message.content
//         }); 

//         const completion = await openai.chat.completions.create({
//             messages: [{
//                 role: "system",
//                 content: messageString
//             }],
//             model: "gpt-3.5-turbo",
//         });

//         return completion.choices[0];
//     } catch (error) {
//         console.error("Error generating text:", error);
//         return "An error occurred while generating text.";
//     }
// }

module.exports = {
    // generateText,
    generateTextGoole,
    generateTestQuestions
}