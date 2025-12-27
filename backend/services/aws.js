const AWS = require("aws-sdk");
const crypto = require("crypto");

AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

const s3 = new AWS.S3();

async function uploadEvidence(fileBuffer, fileName, mimeType) {
  const fileHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");

  const params = {
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: `evidences/${Date.now()}_${fileName}`,
    Body: fileBuffer,
    ContentType: mimeType,
  };

  const uploadResult = await s3.upload(params).promise();

  return {
    url: uploadResult.Location,
    hash: fileHash,
    key: uploadResult.Key,
  };
}

module.exports = {
  uploadEvidence,
};
