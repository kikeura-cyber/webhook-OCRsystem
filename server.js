const fetch = require("node-fetch");
const express = require("express");
const app = express();
app.use(express.json());

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

  // responses が無い場合の安全処理
  if (!data.responses || !data.responses[0]) {
    console.log("Vision API が画像を認識できませんでした:", JSON.stringify(data, null, 2));
    return "(テキストなし)";
  }

  return data.responses[0].fullTextAnnotation?.text || "(テキストなし)";
}

app.post("/formrun-webhook", async (req, res) => {
  console.log("=== 受信したJSON ===");
  console.log(JSON.stringify(req.body, null, 2));

  // form_attachment_urls は JSON文字列なので parse が必要
  const attachments = JSON.parse(req.body.form_attachment_urls);
  const imageUrl = attachments[0];

  console.log("画像URL:", imageUrl);

  try {
    // 画像をダウンロードして base64 に変換
    const response = await fetch(imageUrl);

    if (!response.ok) {
      console.log("画像のダウンロードに失敗:", response.status);
      return res.status(200).send("IMAGE DOWNLOAD ERROR");
    }

    const buffer = await response.buffer();
    const base64Image = buffer.toString("base64");

    // Vision API OCR
    const ocrText = await callVisionAPI(base64Image);
    console.log("OCR結果:", ocrText);

    res.status(200).send("OK");
  } catch (error) {
    console.error("OCR処理中にエラー:", error);
    res.status(500).send("ERROR");
  }
});

app.listen(3000, () => console.log("server started"));
