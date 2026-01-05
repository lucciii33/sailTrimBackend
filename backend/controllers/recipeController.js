const OpenAI = require("openai");
const Fridge = require("../model/fridgeModel");

const Openai = new OpenAI({
  apiKey: process.env.OPEN_IA,
});

async function createrecipe(req, res) {
  const { userId, time, style } = req.body;

  try {
    const fridgeItems = await Fridge.find({ owner: userId });

    if (!fridgeItems || fridgeItems.length === 0) {
      return res
        .status(404)
        .json({ message: "No hay ingredientes en la nevera" });
    }

    const ingredients = fridgeItems
      .map((item) => `${item.name} (${item.quantity}${item.unit})`)
      .join(", ");

    const chatCompletion = await Openai.chat.completions.create({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Eres un chef. Responde solo en JSON con: nombre, ingredientes (array de strings), pasos (array de strings), tiempo (string)",
        },
        {
          role: "user",
          content: `Tengo estos ingredientes en mi nevera: ${ingredients}. Crea UNA receta que pueda hacer en ${time} minutos máximo, estilo ${style}. Usa SOLO los ingredientes que mencioné (puedes usar algunos, no todos). No inventes ingredientes que no tengo. Si no tengo suficientes ingredientes para una receta completa, sugiere algo simple que se pueda hacer con lo que hay.`,
        },
      ],
    });

    const recipe = JSON.parse(chatCompletion.choices[0].message.content); // ← Parseá el JSON

    res.json({
      recipe: recipe,
    });
  } catch (error) {
    console.error("Error generating recipe:", error);
    res.status(500).json({ message: "Error generando receta" });
  }
}

module.exports = {
  createrecipe,
};
