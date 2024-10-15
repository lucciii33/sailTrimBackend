const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const GradedExamSchema = new Schema({
  gradedExam: {
    type: Map, // Mapa para poder tener las preguntas con claves numéricas como en tu ejemplo
    of: new Schema({  // Cada entrada del mapa tendrá este sub-esquema
      question: { type: String, required: false },
      studentAnswer: { type: String, required: false },
      expectedAnswer: { type: String, required: false },
      isCorrect: { type: Boolean, required: false },
      explanation: { type: String, required: false }
    })
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    required: false,
    ref: "User"
},
});

module.exports = mongoose.model('GradedExam', GradedExamSchema);
