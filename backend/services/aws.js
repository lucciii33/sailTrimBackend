const AWS = require("aws-sdk");

// Configuración de AWS
AWS.config.update({
  accessKeyId: process.env.ACCESS_KEY_POLLY_S3, // Cargado desde variables de entorno
  secretAccessKey: process.env.SECRET_KEY_POLLY_S3,
  region: process.env.AWS_REGION || "us-east-1", // Cambia si estás en otra región
});

const polly = new AWS.Polly();
const s3 = new AWS.S3();

// Función para generar audio con Polly
async function generateAudio(text) {
  const params = {
    Text: text,
    OutputFormat: "mp3",
    VoiceId: "Joanna",
  };

  return await polly.synthesizeSpeech(params).promise();
}

// Función para subir archivos a S3
async function uploadToS3(audioStream, bucketName, fileName) {
  const params = {
    Bucket: bucketName,
    Key: fileName,
    Body: audioStream,
    ContentType: "audio/mpeg",
  };

  return await s3.upload(params).promise();
}

module.exports = {
  generateAudio,
  uploadToS3,
};
