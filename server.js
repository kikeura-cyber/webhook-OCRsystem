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

  const targetEntry = entries.find(
    (e) => String(e.id) === String(entryId) || String(e.number) === String(entryNumber)
  ) || entries[0];

  if (!targetEntry) {
    throw new Error(`カードが見つかりませんでした (entry_id: ${entryId}, entry_number: ${entryNumber})`);
  }

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

// 勤務時間の文字列（88:88ガイド枠やOCR誤読）を正しくクレンジング・補正する関数
function cleanTime(str) {
  if (!str) return "";
  let cleanStr = str.replace(/[^\d:：]/g, "").replace("：", ":");
  let [h, m] = cleanStr.split(":");
  if (!m) return cleanStr;

  // ガイド枠「8」の混入を除去（例: 89時 → 9時、88時 → 8時、87時 → 17時など）
  if (h.length === 2 && h.startsWith("8")) {
    h = h.substring(1);
  }

  // 手書き「1」が「7」に誤読された場合の補正（例: 77時 → 17時、78時 → 18時）
  if (h === "77") h = "17";
  if (h === "78") h = "18";
  if (h === "79") h = "19";
  if (h === "76") h = "16";

  // 分が「75」等（手書きの15が75に化けた）の場合の補正
  if (m === "75") m = "15";
  if (m === "70") m = "10";
  if (m === "71") m = "11";

  const hNum = parseInt(h, 10);
  const mNum = parseInt(m, 10);
  if (!isNaN(hNum) && !isNaN(mNum)) {
    return `${String(hNum).padStart(2, "0")}:${String(mNum).padStart(2, "0")}`;
  }

  return `${h}:${m}`;
}

// 休憩時間の誤読補正関数（例: 80 → 60分）
function cleanBreakTime(str) {
  if (!str) return "";
  let cleaned = str.replace(/[^\d]/g, "");
  // ガイド枠「88」と手書き「60」が重なって「80」や「88」に誤読されたケース
  if (cleaned === "80" || cleaned === "60") {
    return "60分";
  }
  if (cleaned === "45") return "45分";
  if (cleaned === "30") return "30分";
  if (cleaned) return `${cleaned}分`;
  return str;
}

// OCRテキストから【氏名・日付・開始時間・終了時間・休憩時間】を抽出（フォールバック用）
function fallbackExtractFields(fullText) {
  const result = {
    name: "",
    date: "",
    startTime: "",
    endTime: "",
    breakTime: ""
  };

  // ★超重要：下部の「備考」「交通費」「就業先」「確認印」以降を完全にカットして上半分だけを対象にする
  const text = fullText.split(/備考|就業先|交通費|確認印/)[0];

  // 1. 氏名の抽出（「氏名」の右隣にある名前）
  const nameMatch = text.match(/(?:氏名|名前|氏\s*名)[：:\s]*([^\r\n\t 　0-9]{2,8})/);
  if (nameMatch) {
    result.name = nameMatch[1].trim();
  }

  // 2. 日付の抽出（例: 10月18日、10/18、10-18）
  const dateMatch = text.match(/(\d{1,2})[月/.-]\s*(\d{1,2})日?/);
  if (dateMatch) {
    result.date = `${dateMatch[1]}月${dateMatch[2]}日`;
  } else {
    // 氏名の右側の数字などを探索（例: 10 18）
    const altDate = text.match(/(?:氏名[^\n]*)\s(\d{1,2})\s*(\d{1,2})/);
    if (altDate) {
      result.date = `${altDate[1]}月${altDate[2]}日`;
    }
  }

  // 3. 時間の抽出（コロンを含む時間文字列）
  const timeMatches = text.match(/\b\d{1,2}[:：]\d{2}\b/g) || [];
  if (timeMatches.length >= 1) {
    result.startTime = cleanTime(timeMatches[0]);
  }
  if (timeMatches.length >= 2) {
    result.endTime = cleanTime(timeMatches[1]);
  }

  // 4. 休憩時間の抽出
  const breakMatch = text.match(/(?:休憩時間|休憩)[^\d\n]*(\d+)/);
  if (breakMatch) {
    result.breakTime = cleanBreakTime(breakMatch[1]);
  } else {
    // 単独で現れる「80 分」や「60 分」
    const standaloneBreak = text.match(/\b(\d{2})\s*分/);
    if (standaloneBreak) {
      result.breakTime = cleanBreakTime(standaloneBreak[1]);
    }
  }

  return result;
}

// AI (Gemini API) を用いて画像そのものから伝票の上部枠内（氏名・日付・開始時間・終了時間・休憩時間）を直接抽出
async function extractFieldsDirectlyFromImage(base64Image, mimeType = "image/jpeg") {
  const apiKey = process.env.GEMINI_API_KEY || process.env.VISION_API_KEY;
  if (!apiKey) {
    console.log("GEMINI_API_KEY / VISION_API_KEY が未設定のため、画像AI抽出をスキップします。");
    return null;
  }

  try {
    const prompt = `あなたはこの勤務伝票（<アットライン控>）の画像を正確に読み取るAIアシスタントです。

【最重要ルール：読み取り範囲の限定】
この伝票の「上半分（上部枠線内）」にある以下の項目のみを抽出し、JSONで返してください。
下部にある「備考（区間や金額など）」「就業先」「交通費」「会社連絡先（電話番号）」「確認印」などは【絶対に抽出・混同せず、完全に無視】してください。

【抽出項目】
1. name: 「氏名」の右隣に手書きされている氏名（例: 坂本 英敏）
2. date: 氏名の右側にある日付（例: 10月18日、10/18など）
3. startTime: 表の「開始時間」列のマス目に手書きされた時間（例: 9:30 または 09:30）。背景にある薄い「88:88」ガイド枠は無視し、手書きされた数字のみを読み取ってください。
4. endTime: 表の「終了時間」列のマス目に手書きされた時間（例: 17:15）。背景にある薄い「88:88」ガイド枠は無視し、手書きされた数字のみを読み取ってください。
5. breakTime: 表の「休憩時間」列のマス目に手書きされた時間や分数（例: 60分、60、1:00 など）。背景のガイド枠は無視してください。

【出力JSONフォーマット】
Markdownコードブロック等は含めず、純粋なJSONのみを出力してください。
{
  "name": "抽出した氏名（不明な場合は空文字）",
  "date": "抽出した日付（不明な場合は空文字）",
  "startTime": "抽出した開始時間（HH:MM形式、不明な場合は空文字）",
  "endTime": "抽出した終了時間（HH:MM形式、不明な場合は空文字）",
  "breakTime": "抽出した休憩時間（例: 60分、不明な場合は空文字）"
}`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    mimeType: mimeType || "image/jpeg",
                    data: base64Image
                  }
                }
              ]
            }
          ],
          generationConfig: {
            responseMimeType: "application/json"
          }
        })
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.log(`Gemini 画像直接認識API失敗 (ステータス: ${res.status}): ${errText}。テキストOCR解析にフォールバックします。`);
      return null;
    }

    const data = await res.json();
    const rawJson = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (rawJson) {
      const parsed = JSON.parse(rawJson);
      console.log("画像からの直接AI抽出に成功しました:", JSON.stringify(parsed));
      return {
        name: parsed.name || "",
        date: parsed.date || "",
        startTime: cleanTime(parsed.startTime || ""),
        endTime: cleanTime(parsed.endTime || ""),
        breakTime: cleanBreakTime(parsed.breakTime || "")
      };
    }
  } catch (err) {
    console.warn("画像直接AI抽出処理中にエラー発生、フォールバックを使用:", err.message);
  }

  return null;
}

// AI (Gemini API) を用いてOCRテキストから項目を構造化抽出（フォールバック用）
async function extractFieldsWithAI(ocrText) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.VISION_API_KEY;
  if (!apiKey) {
    return fallbackExtractFields(ocrText);
  }

  try {
    const prompt = `以下のOCRで読み取った勤務伝票（<アットライン控>）のテキストから、【氏名】、【日付】、【開始時間】、【終了時間】、【休憩時間】を抽出してください。

【重要な注意事項】
- 下部にある「備考（区間や金額など）」「就業先」「交通費」「会社連絡先（電話番号）」「確認印」は絶対に無視してください。
- 上部の「氏名」欄、「日付」、「開始時間」「終了時間」「休憩時間」の枠内の文字のみを抽出してください。
- ガイド枠「88:88」の混入（89:30 → 9:30）や手書き「1」が「7」に誤読されたもの（77:75 → 17:15）は正しく直してください。

必ず以下のJSONフォーマットのみを返してください。Markdownや余計な解説は一切含めないでください。

{
  "name": "抽出した氏名（不明な場合は空文字）",
  "date": "抽出した日付（不明な場合は空文字）",
  "startTime": "抽出した開始時間（HH:MM形式、不明な場合は空文字）",
  "endTime": "抽出した終了時間（HH:MM形式、不明な場合は空文字）",
  "breakTime": "抽出した休憩時間（例: 60分 または 1:00、不明な場合は空文字）"
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
        startTime: cleanTime(parsed.startTime || ""),
        endTime: cleanTime(parsed.endTime || ""),
        breakTime: cleanBreakTime(parsed.breakTime || "")
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

      console.log(`[${i + 1}/${attachments.length}] 伝票フォーマット専用AI抽出中 (上部枠内)...`);
      let extracted = await extractFieldsDirectlyFromImage(base64Image, file.contentType);
      if (!extracted) {
        console.log(`[${i + 1}/${attachments.length}] テキストOCRからの項目抽出へフォールバックします...`);
        extracted = await extractFieldsWithAI(rawText);
      }
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
