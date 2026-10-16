const fetch = require("node-fetch");
const express = require("express");
const app = express();
app.use(express.json());

// Vision API 呼び出し
async function callVisionAPI(base64Image) {
  const apiKey = process.env.VISION_API_KEY;
  if (!apiKey) {
    throw new Error("環境変数 VISION_API_KEY が設定されていません。");
  }

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

  if (data.error) {
    console.error("Vision API エラーレスポンス:", JSON.stringify(data.error, null, 2));
    throw new Error(`Vision API Error: ${data.error.message}`);
  }

  // responses が無い場合の安全処理
  if (!data.responses || !data.responses[0]) {
    console.log("Vision API が画像を認識できませんでした:", JSON.stringify(data, null, 2));
    return "(テキストなし)";
  }

  return data.responses[0].fullTextAnnotation?.text || "(テキストなし)";
}

// formrun API を呼び出してすべての添付ファイル情報（ダウンロード用URL付き）を取得
async function getAttachmentsFromFormrun(formId, entryId, entryNumber) {
  let formrunApiKey = process.env.FORMRUN_API_KEY;
  if (!formrunApiKey) {
    throw new Error("環境変数 FORMRUN_API_KEY が設定されていません。Render等の環境変数に設定してください。");
  }

  // 前後の余計な空白・改行を除去し、もし "Bearer " が含まれていれば除去
  formrunApiKey = formrunApiKey.trim().replace(/^Bearer\s+/i, "");

  console.log(
    "formrun APIキー確認 (長さ: " +
      formrunApiKey.length +
      ", 先頭末尾: " +
      formrunApiKey.slice(0, 4) +
      "..." +
      formrunApiKey.slice(-4) +
      ")"
  );

  const queryParams = new URLSearchParams();
  if (entryNumber) {
    queryParams.append("number_from", entryNumber);
    queryParams.append("number_to", entryNumber);
  }

  const url = `https://form.run/api/public/v1/forms/${formId}/entries?${queryParams.toString()}`;
  console.log("formrun API 呼び出し URL:", url);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${formrunApiKey}`,
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`formrun API エラー (ステータス: ${response.status}): ${errorBody}`);
  }

  const result = await response.json();
  const entries = result.data || [];

  // entryId または entryNumber で一致するカードを探す
  const targetEntry = entries.find(
    (e) => String(e.id) === String(entryId) || String(e.number) === String(entryNumber)
  ) || entries[0];

  if (!targetEntry) {
    throw new Error(`カードが見つかりませんでした (entry_id: ${entryId}, entry_number: ${entryNumber})`);
  }

  // 回答項目 (fields) の中からすべてのファイル添付項目を収集
  const attachments = [];
  for (const field of targetEntry.fields || []) {
    if (field.files && Array.isArray(field.files)) {
      for (const file of field.files) {
        if (file.url) {
          attachments.push({
            filename: file.filename || "image",
            contentType: file.content_type || "",
            size: file.size,
            url: file.url
          });
        }
      }
    }
  }

  if (attachments.length === 0) {
    throw new Error("カード内に添付ファイル (files) が見つかりませんでした。");
  }

  console.log(
    `添付ファイルを計 ${attachments.length} 件取得しました:`,
    attachments.map((a) => a.filename).join(", ")
  );
  return attachments;
}

// formrun のカードに OCR 結果をメモとして追加
async function addMemoToFormrun(formId, entryId, memoText) {
  let formrunApiKey = process.env.FORMRUN_API_KEY;
  if (!formrunApiKey) {
    console.warn("FORMRUN_API_KEY が未設定のためメモ登録をスキップします。");
    return;
  }
  formrunApiKey = formrunApiKey.trim().replace(/^Bearer\s+/i, "");

  const url = `https://form.run/api/public/v1/forms/${formId}/entries/${entryId}/memos`;
  console.log("formrun メモ登録 API 呼び出し URL:", url);

  // メモ本文の作成（APIの10,000文字制限に対応）
  let content = `【AI-OCR 読み取り結果】\n${memoText || "(テキストが検出されませんでした)"}`;
  if (content.length > 9900) {
    content = content.slice(0, 9900) + "\n...(文字数制限のため以降省略)";
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${formrunApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ body: content })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`formrun メモ登録エラー (ステータス: ${response.status}):`, errorBody);
    throw new Error(`formrun メモ登録に失敗しました: ${errorBody}`);
  }

  console.log("formrun カードへのメモ登録が完了しました。");
}

// OCRテキストから【氏名・日付・開始時間・終了時間・休憩時間】を抽出（フォールバック用）
function fallbackExtractFields(text) {
  const result = {
    name: "",
    date: "",
    startTime: "",
    endTime: "",
    breakTime: ""
  };

  // 日付の抽出 (例: 2026/10/16, 2026年10月16日, 10月16日, 10/16)
  const dateMatch = text.match(/(?:20\d{2}[年/.-])?\d{1,2}[月/.-]\d{1,2}日?/);
  if (dateMatch) result.date = dateMatch[0].trim();

  // 時間の抽出 (例: 09:00, 18:00)
  const timeMatches = text.match(/\b\d{1,2}[:：]\d{2}\b/g) || [];
  if (timeMatches.length >= 1) result.startTime = timeMatches[0].replace("：", ":");
  if (timeMatches.length >= 2) result.endTime = timeMatches[1].replace("：", ":");
  if (timeMatches.length >= 3) result.breakTime = timeMatches[2].replace("：", ":");

  // 休憩時間のキーワード抽出 (例: 休憩: 1:00, 休憩 60分 など)
  const breakMatch = text.match(/休憩[^\d\n]*(\d+(?:[:：]\d{2}|時間|\s*分)?)/);
  if (breakMatch && !result.breakTime) {
    result.breakTime = breakMatch[1];
  }

  // 氏名のキーワード抽出 (例: 氏名: 山田太郎, 名前: 山田太郎)
  const nameMatch = text.match(/(?:氏名|名前|氏\s*名)[：:\s]*([^\r\n\t 　]{2,12})/);
  if (nameMatch) {
    result.name = nameMatch[1].trim();
  }

  return result;
}

// AI (Gemini API) を用いてOCRテキストから項目を構造化抽出
async function extractFieldsWithAI(ocrText) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.VISION_API_KEY;
  if (!apiKey) {
    return fallbackExtractFields(ocrText);
  }

  try {
    const prompt = `以下のOCRで読み取った勤務表・タイムカードのテキストから、【氏名】、【日付】、【開始時間】、【終了時間】、【休憩時間】を抽出してください。
必ず以下のJSONフォーマットのみを返してください。Markdownや余計な解説は一切含めないでください。

{
  "name": "抽出した氏名（不明な場合は空文字）",
  "date": "抽出した日付（YYYY/MM/DD形式推奨、不明な場合は空文字）",
  "startTime": "抽出した開始時間（HH:MM形式、不明な場合は空文字）",
  "endTime": "抽出した終了時間（HH:MM形式、不明な場合は空文字）",
  "breakTime": "抽出した休憩時間（例: 1:00 または 60分、不明な場合は空文字）"
}

--- OCRテキスト ---
${ocrText}`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json"
          }
        })
      }
    );

    if (!res.ok) {
      console.log("Gemini API利用不可 (ステータス: " + res.status + ")。ルールベース抽出に切り替えます。");
      return fallbackExtractFields(ocrText);
    }

    const data = await res.json();
    const rawJson = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (rawJson) {
      const parsed = JSON.parse(rawJson);
      return {
        name: parsed.name || "",
        date: parsed.date || "",
        startTime: parsed.startTime || "",
        endTime: parsed.endTime || "",
        breakTime: parsed.breakTime || ""
      };
    }
  } catch (err) {
    console.warn("AI項目抽出でエラー、フォールバックを使用:", err.message);
  }

  return fallbackExtractFields(ocrText);
}

// Googleスプレッドシート（GAS Webアプリ）へ行を追加
async function sendToSpreadsheet(data) {
  const gasUrl = process.env.SPREADSHEET_WEBHOOK_URL;
  if (!gasUrl) {
    console.log("SPREADSHEET_WEBHOOK_URL が未設定のため、スプレッドシート出力をスキップします。");
    return;
  }

  console.log("スプレッドシート書き込みリクエスト送信中...");
  try {
    const response = await fetch(gasUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("スプレッドシート書き込みエラー (ステータス: " + response.status + "):", errorText);
    } else {
      console.log("スプレッドシートへの書き込みが完了しました。");
    }
  } catch (err) {
    console.error("スプレッドシート送信中に例外発生:", err.message || err);
  }
}

app.post("/formrun-webhook", async (req, res) => {
  console.log("=== 受信したJSON ===");
  console.log(JSON.stringify(req.body, null, 2));

  const { form_id, entry_id, entry_number } = req.body;

  try {
    // 1. formrun API からすべての添付ファイル情報を取得
    const attachments = await getAttachmentsFromFormrun(form_id, entry_id, entry_number);

    const emailField = (req.body.fields || []).find(
      (f) => f.label === "メールアドレス" || f.key === "_field_1"
    );
    const email = emailField ? emailField.value : "";

    // 2. すべての画像を順次ダウンロード ＞ OCR ＞ 項目抽出
    const ocrResults = [];
    const spreadsheetRows = [];

    for (let i = 0; i < attachments.length; i++) {
      const file = attachments[i];
      console.log(`[${i + 1}/${attachments.length}] 画像ダウンロード中: ${file.filename}`);

      const imgResponse = await fetch(file.url);
      if (!imgResponse.ok) {
        console.warn(`[${i + 1}/${attachments.length}] ダウンロード失敗 (ステータス: ${imgResponse.status})`);
        continue;
      }

      const buffer = await imgResponse.buffer();
      const base64Image = buffer.toString("base64");

      console.log(`[${i + 1}/${attachments.length}] Vision API OCR 実行中: ${file.filename}`);
      const rawText = await callVisionAPI(base64Image);

      console.log(`[${i + 1}/${attachments.length}] 項目抽出実行中 (氏名・日付・時間)...`);
      const extracted = await extractFieldsWithAI(rawText);
      console.log(`抽出結果:`, JSON.stringify(extracted));

      ocrResults.push({
        index: i + 1,
        filename: file.filename,
        extracted: extracted,
        text: rawText
      });

      // スプレッドシート用の1行データ（画像1枚につき1行）
      spreadsheetRows.push({
        entry_number: entry_number,
        entry_time: req.body.entry_time,
        filename: file.filename,
        name: extracted.name,
        date: extracted.date,
        start_time: extracted.startTime,
        end_time: extracted.endTime,
        break_time: extracted.breakTime,
        email: email,
        entry_card_url: req.body.entry_card_url,
        ocr_text: rawText
      });
    }

    // 3. formrun メモ用テキストの作成
    const memoBlocks = ocrResults.map((r) => {
      return [
        `--- [${r.index}/${ocrResults.length}] ${r.filename} ---`,
        `【氏名】: ${r.extracted.name || "(未検出)"}`,
        `【日付】: ${r.extracted.date || "(未検出)"}`,
        `【開始時間】: ${r.extracted.startTime || "(未検出)"}`,
        `【終了時間】: ${r.extracted.endTime || "(未検出)"}`,
        `【休憩時間】: ${r.extracted.breakTime || "(未検出)"}`,
        `\n[全文テキスト]\n${r.text}`
      ].join("\n");
    });
    const combinedMemoText = memoBlocks.join("\n\n===============\n\n");

    console.log("=== メモ内容 ===");
    console.log(combinedMemoText);

    // 4. formrun の該当カードに OCR 結果をメモとして自動登録
    await addMemoToFormrun(form_id, entry_id, combinedMemoText);

    // 5. Googleスプレッドシートへ自動出力（画像1枚につき1行）
    await sendToSpreadsheet({ rows: spreadsheetRows });

    res.status(200).send("OK");
  } catch (error) {
    console.error("処理中にエラーが発生:", error.message || error);
    res.status(500).send("ERROR");
  }
});

app.listen(3000, () => console.log("server started"));
