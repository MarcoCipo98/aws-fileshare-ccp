const path = require("path");
const express = require("express");
const morgan = require("morgan");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const app = express();

// ----- Config -----
const PORT = process.env.PORT || 8080;
const APP_ENV = process.env.APP_ENV || "local";
const APP_VERSION = process.env.APP_VERSION || "0.0.1-local";

const AWS_REGION = process.env.AWS_REGION;
const S3_BUCKET = process.env.S3_BUCKET;
const DDB_TABLE = process.env.DDB_TABLE;
const PRESIGN_EXPIRES_SECONDS = parseInt(process.env.PRESIGN_EXPIRES_SECONDS);

if (!AWS_REGION || !S3_BUCKET || !DDB_TABLE) {
  console.error("Missing env vars. Please set AWS_REGION, S3_BUCKET, DDB_TABLE in app/.env");
  process.exit(1);
}

// ----- AWS Clients -----
const s3 = new S3Client({ region: AWS_REGION });

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: AWS_REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

// ----- Middlewares -----
app.use(morgan("combined"));
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// ----- Basic Endpoints -----
app.get("/health", (req, res) => res.status(200).send("OK") || res.status(404).send("Not Found"));
app.get("/version", (req, res) => res.json({ version: APP_VERSION }));
app.get("/env", (req, res) => res.json({ env: APP_ENV }));

// Utility: basic input sanity
function requireString(val, name) {
  if (!val || typeof val !== "string" || !val.trim()) {
    const err = new Error(`${name} is required`);
    err.statusCode = 400;
    throw err;
  }
  return val.trim();
}

// ----- Step 1 API -----

// 1) Create presigned PUT URL + create metadata record (UPLOADING)
app.post("/files/presign-upload", async (req, res, next) => {
  try {
    const originalFilename = requireString(req.body.originalFilename, "originalFilename");
    const contentType = requireString(req.body.contentType, "contentType");

    const fileId = uuidv4();
    const safeName = originalFilename.replace(/[^\w.\-]+/g, "_");
    const s3Key = `uploads/${fileId}/${safeName}`;

    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = Math.floor(Date.now() / 1000) + PRESIGN_EXPIRES_SECONDS; // also used as TTL baseline

    // Create presigned PUT URL
    const putCmd = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3, putCmd, { expiresIn: PRESIGN_EXPIRES_SECONDS });

    // Write initial metadata (status UPLOADING)
    await ddb.send(new PutCommand({
      TableName: DDB_TABLE,
      Item: {
        fileId,
        s3Bucket: S3_BUCKET,
        s3Key,
        originalFilename,
        contentType,
        status: "UPLOADING",
        createdAt,
        // Optional TTL: you can choose longer TTL than presign expiry (e.g. 7 days),
        // but for Step 1 keep it simple:
        expiresAt,
        downloadCount: 0
      }
    }));

    res.json({ fileId, uploadUrl, s3Key, expiresAt });
  } catch (e) {
    next(e);
  }
});

// 2) Complete upload: verify S3 object exists, mark READY + store size/type
app.post("/files/complete", async (req, res, next) => {
  try {
    const fileId = requireString(req.body.fileId, "fileId");

    // Load metadata
    const meta = await ddb.send(new GetCommand({
      TableName: DDB_TABLE,
      Key: { fileId }
    }));

    if (!meta.Item) {
      return res.status(404).json({ error: "fileId not found" });
    }
    if (meta.Item.status !== "UPLOADING") {
      return res.status(400).json({ error: `invalid status: ${meta.Item.status}` });
    }

    // Verify object exists in S3 (HEAD)
    const head = await s3.send(new HeadObjectCommand({
      Bucket: meta.Item.s3Bucket,
      Key: meta.Item.s3Key
    }));

    const sizeBytes = head.ContentLength ?? null;
    const storedContentType = head.ContentType ?? meta.Item.contentType;

    // Update metadata to READY
    await ddb.send(new UpdateCommand({
      TableName: DDB_TABLE,
      Key: { fileId },
      UpdateExpression: "SET #s = :ready, sizeBytes = :sz, contentType = :ct",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":ready": "READY",
        ":sz": sizeBytes,
        ":ct": storedContentType
      }
    }));

    res.json({ ok: true, fileId, sizeBytes, contentType: storedContentType });
  } catch (e) {
    next(e);
  }
});

// 3) Get metadata
app.get("/files/:fileId", async (req, res, next) => {
  try {
    const fileId = requireString(req.params.fileId, "fileId");

    const meta = await ddb.send(new GetCommand({
      TableName: DDB_TABLE,
      Key: { fileId }
    }));

    if (!meta.Item) return res.status(404).json({ error: "not found" });

    res.json(meta.Item);
  } catch (e) {
    next(e);
  }
});

// 4) Create presigned GET URL (share)
app.post("/files/:fileId/share", async (req, res, next) => {
  try {
    const fileId = requireString(req.params.fileId, "fileId");

    const meta = await ddb.send(new GetCommand({
      TableName: DDB_TABLE,
      Key: { fileId }
    }));
    if (!meta.Item) return res.status(404).json({ error: "not found" });
    if (meta.Item.status !== "READY") return res.status(400).json({ error: `not ready: ${meta.Item.status}` });

    const getCmd = new GetObjectCommand({
      Bucket: meta.Item.s3Bucket,
      Key: meta.Item.s3Key,
      ResponseContentDisposition: `attachment; filename="${meta.Item.originalFilename}"`
    });

    const downloadUrl = await getSignedUrl(s3, getCmd, { expiresIn: PRESIGN_EXPIRES_SECONDS });

    // Optional: increment share/download counter (simple demo)
    await ddb.send(new UpdateCommand({
      TableName: DDB_TABLE,
      Key: { fileId },
      UpdateExpression: "SET downloadCount = if_not_exists(downloadCount, :zero) + :one",
      ExpressionAttributeValues: { ":zero": 0, ":one": 1 }
    }));

    res.json({ fileId, downloadUrl, expiresAt: Math.floor(Date.now() / 1000) + PRESIGN_EXPIRES_SECONDS });
  } catch (e) {
    next(e);
  }
});

// ----- Error handler -----
app.use((err, req, res, next) => {
  const status = err.statusCode || 500;
  res.status(status).json({ error: err.message || "Internal Server Error" });
});

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log(`APP_ENV=${APP_ENV} APP_VERSION=${APP_VERSION}`);
  console.log(`AWS_REGION=${AWS_REGION} S3_BUCKET=${S3_BUCKET} DDB_TABLE=${DDB_TABLE}`);
});
