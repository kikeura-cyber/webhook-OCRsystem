const express = require("express");
const app = express();
app.use(express.json());

// formrun からの Webhook を受け取る場所
app.post("/formrun-webhook", (req, res) => {
  console.log("formrun webhook received:", req.body);
  res.status(200).send("OK");
});

// Render が使うポート番号
app.listen(3000, () => console.log("server started"));
