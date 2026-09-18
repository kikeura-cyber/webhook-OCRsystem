const fetch = require("node-fetch");
async function callVisionAPI(imageUrl) {
  const apiKey = process.env.VISION_API_KEY; // Render に設定する環境変数

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

const express = require("express");
const app = express();
app.use(express.json());

// formrun からの Webhook を受け取る場所
app.post("/formrun-webhook", async (req, res) => {
  console.log("=== 受信したJSON ===");
  console.log(JSON.stringify(req.body, null, 2));

  res.status(200).send("OK");
});

// Render が使うポート番号
app.listen(3000, () => console.log("server started"));
