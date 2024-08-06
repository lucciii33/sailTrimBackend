// const { Configuration, OpenAIApi } = require('openai');

// const OpenAI = require("openai");
const { parse, stringify } = require('flatted'); 
const { GoogleGenerativeAI } = require("@google/generative-ai");
const apiKey = process.env.GEMINI_KEY; // Replace with your actual key

const genAI = new GoogleGenerativeAI("AIzaSyDa3W2MKxBBjxnjCp6cJfHO8iJcn55B4v4");

const OpenAI = require('openai');
// console.log("OpenAI", OpenAI)

// const configuration = new OpenAI.Configuration({
//     apiKey: "sk-proj-Fwc8MxeXaCJuDr7Rlx1AT3BlbkFJmYQFNyeTqkbXYFyNyewt"
// });

// const openai = new OpenAI.OpenAIApi(configuration);


const Openai = new OpenAI({
  apiKey: "sk-proj-Fwc8MxeXaCJuDr7Rlx1AT3BlbkFJmYQFNyeTqkbXYFyNyewt"
});
console.log("Openai", Openai)




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

    const prompt = `Genera preguntas de prueba sobre el tema ${topic}. Añade "@" al inicio de cada pregunta de respuesta completa, "-" al inicio de cada pregunta de verdadero/falso, "$" al inicio de cada pregunta de opción múltiple y "^" al inicio de cada pregunta de respuesta corta. (máximo 10 preguntas)`;

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

async function generateflashCards(req, res) {
    const { topic } = req.body;

  if (!topic) {
    return res.status(400).send("Topic is required.");
  }

  const prompt = `
    Each flashcard should contain a question and a corresponding answer. Please format the output as follows: Q: [Question] A: [Answer] , Generate a set of study flashcards for the topic "${topic}". `;

  try {
    const model = genAI.getGenerativeModel({ model: "pro-1.5"});
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    console.log(text);
    res.status(200).json({ flashCrads: text });
  } catch (error) {
    console.error("Error generating text:", error);
    return "An error occurred while generating text.";
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
async function generateFeynman(req, res) {

    const { resume } = req.body;
    if (!resume) {
        return res.status(400).send("A resume is required.");
    }

    // Eliminar las etiquetas HTML del texto para que la IA no se confunda
    const plainTextResume = resume.replace(/<\/?[^>]+>/gi, '');

    const prompt = `Estoy practicando la tecnica de Feyman puedes corregirme este resumen: ${plainTextResume} `;


    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = await response.text();
        
        // Procesar la respuesta de la AI
        const resumeAi = text.trim();

        console.log({ resumeAi, resume });
        res.status(200).json({ 
            resumeAi,
            resume
        });
    } catch (error) {
        console.error("Error generating summary:", error);
        res.status(500).send("An error occurred while generating the summary.");
    }
}

async function gradeExam(req, res) {
    const { answers, questions } = req.body;

    if (!answers || !questions) {
        return res.status(400).send("Answers and questions are required.");
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const gradedExam = {};

        for (const key in questions) {
            if (questions.hasOwnProperty(key)) {
                const question = questions[key];
                const studentAnswer = answers[key] ? answers[key].trim().toLowerCase() : "";
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
                gradedExam[key] = {
                    question: question,
                    studentAnswer,
                    expectedAnswer: evaluatedAnswer,
                    isCorrect,
                    explanation: `The correct answer for the question "${question}" is "${evaluatedAnswer}".`
                };
            }
        }

        res.status(200).json({ gradedExam });
    } catch (error) {
        console.error("Error grading exam:", error);
        res.status(500).send("An error occurred while grading exam.");
    }
    
     }
    

async function generateText(req, res) {
    const { prompt } = req.body;
    try {

        const chatCompletion = await Openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{"role": "user", "content": `generated study flashcards for this topic: ${prompt} make sure you add a questions and an anwser both if not this is not going to work, also try to add always more than 10`}],
          });

        const contentString = chatCompletion?.choices[0]?.message.content;

        const qaRegex = /Question:\s*(.*?)\s*Answer:\s*(.*?)(?=\nQuestion:|$)/gs;
        const qaPairs = [];
        let match;

        while ((match = qaRegex.exec(contentString)) !== null) {
            const question = match[1].trim();
            const answer = match[2].trim();
            if (question && answer) {
                qaPairs.push({ question, answer });
            }
        }

        // Prepare the response in the format you need
        const flashCards = qaPairs.map((item, index) => ({
            id: `card-${index + 1}`,
            question: item.question,
            answer: item.answer
        }));

        res.json({
            flashCards
        });

    } catch (error) {
        console.error("Error generating text:", error);
        res.status(500).send("An error occurred while generating text.");
    }
}

async function imagesStory(req, res) {
    const { topic } = req.body;
    try {

        const chatCompletion = await Openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{"role": "user", "content": `puedes ayudarme si te paso este topic: ${topic} a generar imagenes mentales y asociativas para yo entender mejor este tema, methodo de locci`}],
          });

        const contentString = chatCompletion?.choices[0]?.message.content;


        res.json({
            contentString
        });

    } catch (error) {
        console.error("Error generating text:", error);
        res.status(500).send("An error occurred while generating text.");
    }
}

async function generateWordsCombination(req, res) {
    const { word } = req.body;
    if (!word) {
        return res.status(400).send("A resume is required.");
    }

    const prompt = `te voy a pasar esta palabra ${word} necestio que me ayudes a generar algo para recordarles puede ser una historia, un juego de palabras para yo recodar esta mas sencillo`;

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = await response.text();
        
        // Procesar la respuesta de la AI
        const textAi = text.trim();

        res.status(200).json({ 
            word,
            textAi
        });
    } catch (error) {
        console.error("Error generating summary:", error);
        res.status(500).send("An error occurred while generating the summary.");
    }
}

module.exports = {
    generateText,
    generateTextGoole,
    generateTestQuestions,
    gradeExam,
    generateflashCards,
    generateFeynman,
    imagesStory,
    generateWordsCombination
}