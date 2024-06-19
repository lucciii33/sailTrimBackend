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

    const prompt = `Generate test questions for the topic ${topic}. Add "@" at the start of each completion question, "-" at the start of each true/false question, "$" at the start of each multiple choice question, and "^" at the start of each short answer question.(max 40 questions)`;

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

// async function gradeExam(req, res) {
//     const { answers, questions } = req.body;

//     if (!answers || !questions) {
//         return res.status(400).send("Answers and questions are required.");
//     }

//     try {
//         const gradedExam = {};

//         // Fetch AI model to generate expected answers
//         const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

//         // Prepare inputs for the AI model
//         const inputPrompts = questions.map((question, index) => ({
//             prompt: question,
//             student_answer: answers[index] ? answers[index].trim() : "" // Trim the answer if it exists
//         }));

//         // Generate expected answers for all questions using AI model
//         const evaluations = await Promise.all(inputPrompts.map(prompt =>
//             model.generateContent({
//                 question: prompt.prompt,
//                 student_answer: prompt.student_answer
//             }).then(result => ({
//                 evaluatedAnswer: result.response.text(),
//                 question: prompt.prompt,
//                 studentAnswer: prompt.student_answer
//             }))
//         ));

//         // Compare evaluated answers with student answers
//         evaluations.forEach(({ evaluatedAnswer, question, studentAnswer }) => {
//             const questionIndex = questions.indexOf(question); // Get the index of the question
//             const expectedAnswer = evaluatedAnswer.trim(); // Trim the evaluated answer

//             let isCorrect = false;
//             let explanation = "";

//             // Determine question type based on prompt (assuming structure of prompt)
//             const questionType = getQuestionType(question);

//             switch (questionType) {
//                 case '@': // Completion question
//                     isCorrect = evaluatedAnswer.toLowerCase().includes(studentAnswer.toLowerCase());
//                     explanation = `The correct answer for the completion question "${question}" is "${evaluatedAnswer}".`;
//                     break;
//                 case '-': // True/False question
//                     isCorrect = (studentAnswer === 'true') === (evaluatedAnswer.toLowerCase() === 'true');
//                     explanation = `The statement "${question}" is ${evaluatedAnswer.toLowerCase() === 'true' ? "true" : "false"}.`;
//                     break;
//                 case '$': // Multiple choice question
//                     isCorrect = evaluatedAnswer.toLowerCase() === studentAnswer.toLowerCase();
//                     explanation = `The correct option for the question "${question}" is "${evaluatedAnswer}".`;
//                     break;
//                 case '^': // Short answer question
//                     isCorrect = evaluatedAnswer.toLowerCase().includes(studentAnswer.toLowerCase());
//                     explanation = `The correct answer for the short answer question "${question}" includes "${evaluatedAnswer}".`;
//                     break;
//                 default:
//                     break;
//             }

//             // Store the result for each question
//             gradedExam[questionIndex] = {
//                 studentAnswer,
//                 expectedAnswer,
//                 isCorrect,
//                 explanation
//             };
//         });

//         // Send the graded exam results as JSON response
//         res.status(200).json({ gradedExam });
//     } catch (error) {
//         console.error("Error grading exam:", error);
//         res.status(500).send("An error occurred while grading exam.");
//     }
// }

async function gradeExam(req, res) {
    const { answers, questions } = req.body;

    if (!answers || !questions) {
        return res.status(400).send("Answers and questions are required.");
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const gradedExam = {};

        for (let i = 0; i < questions.length; i++) {
            const question = questions[i];
            const studentAnswer = answers[i] ? answers[i].trim().toLowerCase() : "";
            let evaluatedAnswer = "";

            try {
                // Generate AI response for the current question
                const result = await model.generateContent(question);
                evaluatedAnswer = await result.response.text();
                evaluatedAnswer = evaluatedAnswer.trim().toLowerCase(); // Trim any extra whitespace
            } catch (error) {
                console.error("Error generating content:", error);
                evaluatedAnswer = ""; // Handle error case gracefully
            }

            // Determine if student's answer matches the evaluated answer
            const isCorrect = evaluatedAnswer.includes(studentAnswer.toLowerCase().trim());

            // Store the result for each question
            gradedExam[i] = {
                question: question,
                studentAnswer,
                expectedAnswer: evaluatedAnswer,
                isCorrect,
                explanation: `The correct answer for the question "${question}" is "${evaluatedAnswer}".`
            };
        }

        res.status(200).json({ gradedExam });
    } catch (error) {
        console.error("Error grading exam:", error);
        res.status(500).send("An error occurred while grading exam.");
    }
    
     }
    

// // Function to determine question type based on prompt text
// function getQuestionType(questionText) {
//     if (questionText.startsWith('@')) return '@'; // Completion question
//     if (questionText.startsWith('-')) return '-'; // True/False question
//     if (questionText.startsWith('$')) return '$'; // Multiple choice question
//     if (questionText.startsWith('^')) return '^'; // Short answer question
//     return ''; // Default case
// }

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
    generateTestQuestions,
    gradeExam
}