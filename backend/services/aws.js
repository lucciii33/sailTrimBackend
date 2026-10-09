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

/**
 * Upload something PRIVATE and hand back the key, never a public URL.
 *
 * Playwright's video and trace are a recording of the customer's app in a
 * logged-in session: their data on screen, their tokens in the network log.
 * uploadEvidence above returns `uploadResult.Location`, which on a
 * publicly-readable bucket is a link anyone can open forever — which is exactly
 * why video and traces were switched off instead of shipped.
 *
 * So these go up with no public read, and are served through short-lived signed
 * URLs minted per request (see signedUrl).
 */
async function uploadPrivate(fileBuffer, key, mimeType) {
  await s3
    .upload({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
      Body: fileBuffer,
      ContentType: mimeType,
      // Private even if the bucket's default is not.
      ACL: "private",
    })
    .promise();
  return { key };
}

/**
 * A link to a private object that stops working. Minted when someone asks to
 * watch, so a leaked URL is useless an hour later.
 */
function signedUrl(key, { expiresInSeconds = 3600 } = {}) {
  if (!key) return "";
  return s3.getSignedUrl("getObject", {
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key,
    Expires: expiresInSeconds,
  });
}

async function deletePrivate(key) {
  if (!key) return;
  await s3
    .deleteObject({ Bucket: process.env.AWS_BUCKET_NAME, Key: key })
    .promise()
    .catch(() => {});
}

module.exports = {
  uploadEvidence,
  uploadPrivate,
  signedUrl,
  deletePrivate,
};
