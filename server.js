const fetch = require("node-fetch");
const express = require("express");
const app = express();
app.use(express.json());

// 画像をダウンロードして base64 に変換
async function downloadImageAsBase64(url) {
  const response = await fetch(url);
  const buffer = await response.buffer();
  return buffer.toString("base64");
}

// Vision API 呼び出し（base64方式）
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

  // fields から画像URLを取得
  const fileField = req.body.fields.find(f => f.label === "ファイルアップロード");
  const imageUrl = fileField ? fileField.value : null;

  console.log("画像URL:", imageUrl);

  if (!imageUrl) {
    console.log("画像URLが見つかりません");
    return res.status(200).send("NO IMAGE");
  }

  // 画像をダウンロードして base64 に変換
  const base64Image = await downloadImageAsBase64(imageUrl);

  // Vision API OCR
  const ocrText = await callVisionAPI(base64Image);
  console.log("OCR結果:", ocrText);

  res.status(200).send("OK");
});

app.listen(3000, () => console.log("server started"));
