const OpenAI = require("openai");
const Fridge = require("../model/fridgeModel");
const Recipe = require("../model/recipeModel");
const asyncHandler = require("express-async-handler");

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

const createRecipeAfter = asyncHandler(async (req, res) => {
  const resp = req.body;

  try {
    const recipe = await Recipe.create(resp);
    return res.status(201).json(recipe);
  } catch (error) {
    return res.status(500).json({
      message: "Internal server error",
    });
  }
});

const getRecipeById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const recipe = await Recipe.findById(id);

  if (!recipe) {
    return res.status(404).json({ message: "Recipe not found" });
  }

  return res.json(recipe);
});

const getRecipeByUserId = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const recipes = await Recipe.find({ owner: id });

  if (!recipes) {
    return res.status(404).json({ message: "Recipes not found" });
  }

  return res.json(recipes);
});

const deleteRecipeById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const recipe = await Recipe.findByIdAndDelete(id);
  if (!recipe) {
    return res.status(404).json({ message: "Recipe not found" });
  }

  return res.json({ message: "Recipe deleted successfully" });
});

const updateRecipeById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const data = req.body;

  const recipes = await Recipe.findByIdAndUpdate(id, data, { new: true });
  if (!recipes || recipes.length === 0) {
    return res.status(404).json({ message: "Recipe not found" });
  }

  return res.json(recipes);
});

module.exports = {
  createrecipe,
  createRecipeAfter,
  getRecipeById,
  getRecipeByUserId,
  deleteRecipeById,
  updateRecipeById,
};
