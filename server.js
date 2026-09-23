const fetch = require("node-fetch");
const express = require("express");
const app = express();
app.use(express.json());

const FORMRUN_API_KEY = process.env.FORMRUN_API_KEY;

// formrun API で添付ファイルの本物URLを取得
async function getRealAttachmentUrl(formId, entryId) {
  const url = `https://api.form.run/v2/forms/${formId}/entries/${entryId}`;

  const response = await fetch(url, {
    headers: {
      "X-Formrun-Api-Key": FORMRUN_API_KEY
    }
  });

  const data = await response.json();

  // 添付ファイルの本物URL（署名付きURL）
  return data.entry.attachments[0].url;
}

// 画像をダウンロードして base64 に変換
async function downloadImageAsBase64(url) {
  const response = await fetch(url);
  const buffer = await response.buffer();
  return buffer.toString("base64");
}

// Vision API 呼び出し
async function callVisionAPI(base64Image) {
  const apiKey = process.env.VISION_API_KEY;

  const requestBody = {
    requests: [
      {
        image: { content: base64Image },
        features: [{ type: "TEXT_DETECTION" }]
      }
    ]
  };

  const response = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    }
  );

  const data = await response.json();
  return data.responses[0].fullTextAnnotation?.text || "(テキストなし)";
}

// Webhook 受信
app.post("/formrun-webhook", async (req, res) => {
  console.log("=== 受信したJSON ===");
  console.log(JSON.stringify(req.body, null, 2));

  const formId = req.body.form_id;
  const entryId = req.body.entry_id;

  // formrun API で本物の画像URLを取得
  const realUrl = await getRealAttachmentUrl(formId, entryId);
  console.log("本物の画像URL:", realUrl);

  // 画像をダウンロードして base64 に変換
  const base64Image = await downloadImageAsBase64(realUrl);

  // Vision API OCR
  const ocrText = await callVisionAPI(base64Image);
  console.log("OCR結果:", ocrText);

  res.status(200).send("OK");
});

app.listen(3000, () => console.log("server started"));
