const fetch = require("node-fetch");
const express = require("express");
const app = express();
app.use(express.json());

// Vision API 呼び出し関数
async function callVisionAPI(imageUrl) {
  const apiKey = process.env.VISION_API_KEY;

  const requestBody = {
    requests: [
      {
        image: { source: { imageUri: imageUrl } },
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
  return data.responses[0].fullTextAnnotation.text;
}

// Webhook 受信
app.post("/formrun-webhook", async (req, res) => {
  console.log("=== 受信したJSON ===");
  console.log(JSON.stringify(req.body, null, 2));

  // fields から「ファイルアップロード」を探す
  const fileField = req.body.fields.find(f => f.label === "ファイルアップロード");
  const imageUrl = fileField ? fileField.value : null;

  console.log("画像URL:", imageUrl);

  if (!imageUrl) {
    console.log("画像URLが見つかりませんでした");
    return res.status(200).send("NO IMAGE");
  }

  // Vision API OCR
  const ocrText = await callVisionAPI(imageUrl);
  console.log("OCR結果:", ocrText);

  res.status(200).send("OK");
});

app.listen(3000, () => console.log("server started"));
