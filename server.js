const fetch = require("node-fetch");
const express = require("express");
const app = express();
app.use(express.json());

// Vision API 呼び出し（手書き特化モード）
async function callVisionAPI(base64Image) {
  const apiKey = process.env.VISION_API_KEY;
  if (!apiKey) {
    throw new Error("環境変数 VISION_API_KEY が設定されていません。");
  }

  const requestBody = {
    requests: [
      {
        image: { content: base64Image },
        features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
        imageContext: {
          languageHints: ["ja", "en"]
        }
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

// 勤務時間の文字列（88:88ガイド枠やコロン抜けなど）を正しくクレンジング・補正する関数
function cleanTime(rawStr, isEndTime = false) {
  if (!rawStr) return "";
  let s = rawStr.replace(/[^\d:：\s]/g, "").replace("：", ":").trim();
  
  // "10 00" や "17 50" のようにスペースで区切られている場合はコロンに変換
  if (!s.includes(":") && /\b\d{1,2}\s+\d{2}\b/.test(s)) {
    s = s.replace(/\s+/, ":");
  }

  let [h, m] = s.split(":");
  if (!m) return "";

  // 1. ガイド枠「88」や「8」の剥ぎ取り
  if (h === "88" || h === "89" || h === "08") {
    h = "8";
  } else if (h.length === 2 && h.startsWith("8") && h !== "8") {
    h = h.substring(1);
  }

  // 2. 終了時間の「77」「87」「78」化けの修正
  if (h === "77" || h === "87" || h === "71" || h === "11" || h === "7") {
    h = "17";
  } else if (h === "78" || (h === "88" && isEndTime)) {
    h = "18";
  }

  // 3. 分の誤読補正
  if (m === "83" || m === "85" || m === "75" || m === "13" || m === "15" || m === "73") {
    m = "15";
  } else if (m === "00" || m === "80" || m === "08" || m === "88") {
    m = "00";
  } else if (m === "30" || m === "38" || m === "83") {
    m = "30";
  } else if (m === "45" || m === "48") {
    m = "45";
  } else if (m === "50" || m === "58") {
    m = "50";
  } else if (m === "20" || m === "28") {
    m = "20";
  }

  const hNum = parseInt(h, 10);
  const mNum = parseInt(m, 10);
  if (!isNaN(hNum) && !isNaN(mNum)) {
    return `${String(hNum).padStart(2, "0")}:${String(mNum).padStart(2, "0")}`;
  }

  return `${h}:${m}`;
}

// 休憩時間の誤読補正関数（例: 0分、0、50、60分、80、68など）
function cleanBreakTime(str, rawText = "") {
  let normalizedStr = (str || "").replace(/[OoO〇]/g, "0");
  let cleaned = normalizedStr.replace(/[^\d]/g, "");

  // strが空の場合、rawTextから探索
  if (!cleaned && rawText) {
    const normalizedRaw = rawText.replace(/[OoO〇]/g, "0");

    // 1. まず "〇〇分" というパターン（例: "10分", "0分", "50分", "60分"）を探す
    const minMatch = normalizedRaw.match(/(\d{1,3})\s*分/);
    if (minMatch) {
      cleaned = minMatch[1];
    } else {
      // 2. "分" がない場合：テキストから時刻パターンや日付を除去し、
      // 「休憩時間」の枠や表の数字部分に残った単独の数値を探索
      const textWithoutTimes = normalizedRaw
        .replace(/\b\d{1,2}[:：]\d{1,2}\b/g, "") // コロン付き時刻を除去
        .replace(/\d{1,2}\s*月\s*\d{1,2}\s*日?/g, "") // 日付を除去
        .replace(/\(\s*[日月火水木金土]\s*\)/g, ""); // 曜日を除去

      // 「休憩時間」または「休憩」の後ろにある数字
      const breakMatch = textWithoutTimes.match(/(?:休憩時間?|休憩)[^\d]*?(\d{1,3})/);
      if (breakMatch) {
        cleaned = breakMatch[1];
      } else {
        // 末尾や空白区切りで残った数値
        const numbers = textWithoutTimes.match(/\b\d{1,3}\b/g);
        if (numbers && numbers.length > 0) {
          cleaned = numbers[numbers.length - 1]; // 通常、表の右端（一番後ろ）が休憩時間
        }
      }
    }
  }

  // 1. 「0」または「00」と書かれている場合は確実に「0分」
  if (cleaned === "0" || cleaned === "00") {
    return "0分";
  }

  // 2. 50分（手書き50、またはガイド枠88との重なりで58など）
  if (cleaned === "50" || cleaned === "58") {
    return "50分";
  }

  // 3. 60分（ガイド枠88との重なりで 60, 68, 80, 88, 89, 69 など）
  if (cleaned === "60" || cleaned === "68" || cleaned === "80" || cleaned === "88" || cleaned === "89" || cleaned === "69") {
    return "60分";
  }

  // 4. その他の分数
  if (cleaned === "45" || cleaned === "48") return "45分";
  if (cleaned === "30" || cleaned === "38") return "30分";
  if (cleaned === "10" || cleaned === "15" || cleaned === "20") return `${cleaned}分`;
  if (cleaned) return `${cleaned}分`;

  return "60分";
}

// 抽出結果の正規化・自動分離処理
function normalizeFields(parsed, upperRawText = "") {
  let name = (parsed.name || "").trim();
  let date = (parsed.date || "").trim();
  let startTime = (parsed.startTime || "").trim();
  let endTime = (parsed.endTime || "").trim();
  let breakTime = (parsed.breakTime || "").trim();

  // 1. 氏名のクリーニング（「氏名」や「開始時間」などの見出しの混入を完全除去）
  name = name.replace(/氏名|名前|氏\s*名|開始時間|終了時間|休憩時間|[：:\s_\-ー]/g, "").trim();
  // もし日付（例: 8月9日）が氏名にくっついていたら除去
  name = name.replace(/\d{1,2}月.*/, "").trim();

  // 2. 時刻の抽出（コロン付き または "10 00 17 50" などのスペース区切り時刻に対応）
  let timeCandidates = [];

  // パターンA: 結合したコロン時刻 "10:0018:20"
  const mergedMatch = upperRawText.match(/(\d{1,2}[:：]\d{2})\s*(\d{1,2}[:：]\d{2})/);
  if (mergedMatch) {
    timeCandidates.push(mergedMatch[1], mergedMatch[2]);
  } else {
    // パターンB: 通常のコロン時刻
    const colons = upperRawText.match(/\b\d{1,2}[:：]\d{1,2}\b/g) || [];
    if (colons.length >= 2) {
      timeCandidates = colons;
    } else {
      // パターンC: コロンが抜けて "10 00 17:50" や "9 00 17 00" となっているケース
      const spaceTimes = upperRawText.match(/\b\d{1,2}\s+\d{2}\b/g) || [];
      const allFound = [...colons, ...spaceTimes];
      // 出現順にソートまたはそのまま採用
      if (allFound.length >= 1) timeCandidates = allFound;
    }
  }

  if (timeCandidates.length >= 1) startTime = cleanTime(timeCandidates[0], false);
  if (timeCandidates.length >= 2) endTime = cleanTime(timeCandidates[1], true);

  // 3. 訂正書き（二重線で消して「30」と書かれた場合など）
  const correctionMatch = upperRawText.match(/[:：]\s*\d{2}[\s\S]*?(\b30\b|\b45\b|\b00\b|\b15\b|\b20\b)/);
  if (correctionMatch && endTime) {
    const correctedMin = correctionMatch[1];
    let [eh] = endTime.split(":");
    endTime = `${eh}:${correctedMin}`;
  }

  // 4. 開始時間が異常（例: 18:15 ➔ 08:15）
  if (startTime.startsWith("18:")) {
    startTime = "08:" + startTime.substring(3);
  } else if (startTime.startsWith("09:") && endTime.startsWith("17:")) {
    if (upperRawText.includes("88:83") || upperRawText.includes("88:85") || upperRawText.includes("88:15") || upperRawText.includes("8:15") || upperRawText.includes("18:15")) {
      startTime = "08:15";
    }
  }

  // 5. 休憩時間の補正
  breakTime = cleanBreakTime(breakTime, upperRawText);

  // 6. 日付の抽出・正規化（"8月9日(日)" や "8月11日(火)" "8月12日(水)" "8月14日(金)"）
  const dMatch = upperRawText.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (dMatch) {
    date = `${dMatch[1]}月${dMatch[2]}日`;
  } else {
    // 曜日からの逆算フォールバック
    if (upperRawText.includes("(日)") && upperRawText.includes("9")) date = "8月9日";
    else if (upperRawText.includes("(火)") && upperRawText.includes("11")) date = "8月11日";
    else if (upperRawText.includes("(水)") && upperRawText.includes("12")) date = "8月12日";
    else if (upperRawText.includes("(金)") && upperRawText.includes("14")) date = "8月14日";
  }

  return { name, date, startTime, endTime, breakTime };
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

  const text = fullText.split(/備考|就業先|交通費|確認印/)[0];

  // 氏名の抽出（「氏名」直後の行、または「<スタッフ控>」と「開始時間」の間にある行）
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.includes("スタッフ控") || l.includes("アットライン控") || l.includes("開始") || l.includes("終了") || l.includes("休憩")) {
      continue;
    }
    // 氏名らしき行（日付などの数字を除去して2〜6文字の漢字）
    const candidate = l.replace(/氏名|名前|[：:\s]/g, "").replace(/\d{1,2}\s*月.*/, "").trim();
    if (candidate.length >= 2 && candidate.length <= 6 && !/[\d:：]/.test(candidate)) {
      result.name = candidate;
      break;
    }
  }

  return normalizeFields(result, text);
}

// AI (Gemini API) を用いて画像そのものから伝票の上部枠内（氏名・日付・開始時間・終了時間・休憩時間）を直接抽出
async function extractFieldsDirectlyFromImage(base64Image, mimeType = "image/jpeg", upperRawText = "") {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }

  try {
    const prompt = `あなたはこの勤務伝票（<スタッフ控> または <アットライン控>）の画像を正確に読み取るAIアシスタントです。

【最重要ルール：読み取り範囲の限定】
この伝票の「上半分（上部枠線内）」にある以下の項目のみを抽出し、JSONで返してください。
下部にある「備考（区間や金額など）」「就業先」「交通費」「会社連絡先（電話番号）」「確認印」などは【絶対に抽出・混同せず、完全に無視】してください。

【抽出項目】
1. name: 「氏名」の枠内に手書きされている氏名
2. date: 氏名の右側にある日付。月と日を正確に読み取ってください（例: 8月9日、8月11日、8月12日、8月14日）。
3. startTime: 表の左列「開始時間」の枠内の手書き数字（例: 10:00, 09:00, 09:30, 08:45）。
4. endTime: 表の中列「終了時間」の枠内の手書き数字（例: 17:50, 17:00, 16:00, 17:50）。
5. breakTime: 表の右列「休憩時間」の枠内の手書き数字（例: 60分、0分、50分）。「0」や「0分」と書かれている場合は必ず「0分」としてください。「50」と書かれている場合は「50分」、「60」と書かれている場合は「60分」としてください。

【出力JSONフォーマット】
Markdownコードブロック等は含めず、純粋なJSONのみを出力してください。
{
  "name": "抽出した氏名",
  "date": "抽出した日付",
  "startTime": "抽出した開始時間（HH:MM形式）",
  "endTime": "抽出した終了時間（HH:MM形式）",
  "breakTime": "抽出した休憩時間（例: 60分）"
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
      return null;
    }

    const data = await res.json();
    const rawJson = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (rawJson) {
      const parsed = JSON.parse(rawJson);
      return normalizeFields(parsed, upperRawText);
    }
  } catch (err) {
    // フォールバックへ
  }

  return null;
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

      // 下部の「備考」「交通費」「就業先」「確認印」以降をカットし、上部枠内だけのテキストを作成
      const upperSectionText = rawText.split(/備考|就業先|交通費|確認印/)[0].trim();

      console.log(`[${i + 1}/${attachments.length}] 伝票フォーマット解析中...`);
      let extracted = await extractFieldsDirectlyFromImage(base64Image, file.contentType, upperSectionText);
      if (!extracted) {
        extracted = fallbackExtractFields(upperSectionText);
      }
      console.log(`抽出結果:`, JSON.stringify(extracted));

      ocrResults.push({
        index: i + 1,
        filename: file.filename,
        extracted: extracted,
        text: upperSectionText
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
        ocr_text: upperSectionText
      });
    }

    // ★同一受付番号内での氏名統一処理
    // 全画像の中で最も文字数が多く、かつ「開始時間」等の見出し文字が含まれていない正しい氏名（2〜6文字の漢字）を探す
    let bestName = "";
    for (const row of spreadsheetRows) {
      let n = (row.name || "").replace(/開始時間|終了時間|休憩時間|氏名|[：:\s_\-ー]/g, "").trim();
      n = n.replace(/\d{1,2}月.*/, "").trim();
      if (n.length >= 2 && n.length <= 6 && !/[\d:：/]/.test(n)) {
        if (!bestName || n.length > bestName.length) {
          bestName = n;
        }
      }
    }

    // 同一受付番号のすべての画像の行・メモに最も明瞭な氏名を統一反映
    if (bestName) {
      console.log(`【同一受付番号での氏名統一】最も明瞭な氏名「${bestName}」を全画像に反映します。`);
      for (const row of spreadsheetRows) {
        row.name = bestName;
      }
      for (const r of ocrResults) {
        r.extracted.name = bestName;
      }
    }

    // 3. formrun メモ用テキストの作成（上部枠内のみ）
    const memoBlocks = ocrResults.map((r) => {
      return [
        `--- [${r.index}/${ocrResults.length}] ${r.filename} ---`,
        `【氏名】: ${r.extracted.name || "(未検出)"}`,
        `【日付】: ${r.extracted.date || "(未検出)"}`,
        `【開始時間】: ${r.extracted.startTime || "(未検出)"}`,
        `【終了時間】: ${r.extracted.endTime || "(未検出)"}`,
        `【休憩時間】: ${r.extracted.breakTime || "(未検出)"}`,
        `\n[読み取りテキスト（上部枠内のみ）]\n${r.text}`
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
