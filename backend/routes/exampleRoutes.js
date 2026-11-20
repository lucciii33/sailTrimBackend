const express = require("express");
const router = express.Router();

// EXAMPLE routes to teach Postman (no auth, so they are easy to test).
const {
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
} = require("../controllers/exampleController");

router.get("/getProducts", getProducts);
router.get("/getProductById/:id", getProductById);
router.post("/createProduct", createProduct);
router.put("/updateProduct/:id", updateProduct);
router.delete("/deleteProduct/:id", deleteProduct);

module.exports = router;
