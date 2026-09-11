// EXAMPLE controller to teach Postman.
// In-memory data (no database): it resets when the server restarts.
const asyncHandler = require("express-async-handler");

let products = [
  { id: 1, name: "T-shirt", price: 20 },
  { id: 2, name: "Pants", price: 40 },
  { id: 3, name: "Shoes", price: 60 },
];

// GET  /api/example/getProducts
const getProducts = asyncHandler(async (req, res) => {
  return res.json(products);
});

// GET  /api/example/getProductById/:id
const getProductById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const product = products.find((p) => p.id === Number(id));
  if (!product) {
    return res.status(404).json({ message: "Product not found" });
  }
  return res.json(product);
});

// POST /api/example/createProduct   body: { name, price }
const createProduct = asyncHandler(async (req, res) => {
  const { name, price } = req.body;
  if (!name || price == null) {
    return res.status(400).json({ message: "name and price are required" });
  }
  const newProduct = {
    id: products.length ? products[products.length - 1].id + 1 : 1,
    name,
    price,
  };
  products.push(newProduct);
  return res.status(201).json(newProduct);
});

// PUT  /api/example/updateProduct/:id   body: { name?, price? }
const updateProduct = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const product = products.find((p) => p.id === Number(id));
  if (!product) {
    return res.status(404).json({ message: "Product not found" });
  }
  const { name, price } = req.body;
  if (name !== undefined) product.name = name;
  if (price !== undefined) product.price = price;
  return res.json(product);
});

// DELETE /api/example/deleteProduct/:id
const deleteProduct = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const index = products.findIndex((p) => p.id === Number(id));
  if (index === -1) {
    return res.status(404).json({ message: "Product not found" });
  }
  const deleted = products.splice(index, 1)[0];
  return res.json({ message: "Product deleted", product: deleted });
});

module.exports = {
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
};
