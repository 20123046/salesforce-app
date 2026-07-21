const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'skillwish-session-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

const CLIENT_ID = '3MVG9dAEux2v1sLsanaEKCjSSQ_G6jr2tf1UfoqoDaatPadDVlk4FSQpA4LkkAvD.dllUdAmKjYqhObcyhpLV';
const REDIRECT_URI = 'https://salesforce-app-3-wwtz.onrender.com';
const SF_LOGIN_URL = 'https://login.salesforce.com';

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'password123';

// ----------------------------------------------------
// 📦 サーバーダウン対策：ローカルデータファイル永続化処理
// ----------------------------------------------------
// 📦 サーバーダウン対策：ローカルデータファイル永続化処理
const DATA_FILE = path.join(__dirname, 'local_data.json');

let customHospitals = [];
let skills = [];
let studentMaster = []; // ★ ここで宣言を追加

// サーバー起動時にファイルからデータを復元
if (fs.existsSync(DATA_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        customHospitals = savedData.customHospitals || [];
        skills = savedData.skills || [];
        // ★ 起点日時もファイルから復元できるようにする
        global.currentAcademicYearStart = savedData.academicYearStart || null;
        console.log('📦 ローカルファイルからデータを復元しました:', { customHospitals, skills, academicYearStart: global.currentAcademicYearStart });
    } catch (e) {
        console.error('❌ ローカルファイルの読み込み失敗:', e.message);
    }
}

// データ保存用ヘルパー関数（academicYearStart も一緒に保存する）
function saveDataLocally() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify({ 
            customHospitals, 
            skills, 
            academicYearStart: global.currentAcademicYearStart 
        }, null, 2));
        console.log('💾 ローカルデータをファイルへ保存しました');
    } catch (e) {
        console.error('❌ ローカルデータの保存失敗:', e.message);
    }
}

function generatePKCE() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

// 🌐 ログイン状態確認
app.get('/api/check-auth', (req, res) => {
    res.json({ authenticated: !!req.session.accessToken });
});

// 🔑 ログイン（学生）
app.get('/login', (req, res) => {
    const { verifier, challenge } = generatePKCE();
    req.session.codeVerifier = verifier;
    req.session.loginSource = 'student';

    const authUrl = `${SF_LOGIN_URL}/services/oauth2/authorize?` + new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256'
    }).toString();
    res.redirect(authUrl);
});

// 🔑 ログイン（管理者）
app.get('/admin/login-sf', (req, res) => {
    const { verifier, challenge } = generatePKCE();
    req.session.codeVerifier = verifier;
    req.session.loginSource = 'admin';

    const authUrl = `${SF_LOGIN_URL}/services/oauth2/authorize?` + new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256'
    }).toString();
    res.redirect(authUrl);
});

// 🔄 OAuth2 コールバック
app.get('/oauth2/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('認証コードが取得できませんでした。');

    try {
        const tokenResponse = await axios.post(`${SF_LOGIN_URL}/services/oauth2/token`, new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: CLIENT_ID,
            redirect_uri: REDIRECT_URI,
            code_verifier: req.session.codeVerifier,
            code: code
        }).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        req.session.accessToken = tokenResponse.data.access_token;
        req.session.instanceUrl = tokenResponse.data.instance_url;

        if (req.session.loginSource === 'admin') {
            res.redirect('/admin.html');
        } else {
            res.redirect('/');
        }
    } catch (err) {
        const errorDetail = err.response ? JSON.stringify(err.response.data) : err.message;
        res.status(500).send(`<h1>❌ 認証失敗</h1><pre>${errorDetail}</pre>`);
    }
});

// 🏥 実習先取得 API (Salesforce から動的取得 + ローカル追加分)
app.get('/api/hospitals', async (req, res) => {
    let sfChoices = [];

    if (req.session.accessToken && req.session.instanceUrl) {
        try {
            const describeUrl = `${req.session.instanceUrl}/services/data/v58.0/sobjects/Skill_Wish__c/describe`;
            const response = await axios.get(describeUrl, {
                headers: { 'Authorization': `Bearer ${req.session.accessToken}` },
                timeout: 5000
            });

            const firstChoiceField = response.data.fields.find(f => f.name === 'FirstChoice__c');
            if (firstChoiceField && firstChoiceField.picklistValues) {
                sfChoices = firstChoiceField.picklistValues
                    .filter(val => val.active)
                    .map(val => val.value);
            }
        } catch (err) {
            console.error('Salesforceからの実習先選択肢取得エラー:', err.message);
        }
    }

    if (sfChoices.length === 0 && customHospitals.length === 0) {
        sfChoices = ["A中央病院", "B総合クリニック", "C調剤薬局"];
    }

    const mergedHospitals = Array.from(new Set([...sfChoices, ...customHospitals]));
    res.json(mergedHospitals);
});

// 💉 スキル取得 API (Salesforce から動的取得 + ローカル追加分) 【★改修】
app.get('/api/skills', async (req, res) => {
    let sfSkills = [];

    if (req.session.accessToken && req.session.instanceUrl) {
        try {
            const describeUrl = `${req.session.instanceUrl}/services/data/v58.0/sobjects/Skill_Wish__c/describe`;
            const response = await axios.get(describeUrl, {
                headers: { 'Authorization': `Bearer ${req.session.accessToken}` },
                timeout: 5000
            });

            const skillField = response.data.fields.find(f => f.name === 'Skill__c');
            if (skillField && skillField.picklistValues) {
                sfSkills = skillField.picklistValues
                    .filter(val => val.active)
                    .map(val => val.value);
            }
        } catch (err) {
            console.error('Salesforceからのスキル選択肢取得エラー:', err.message);
        }
    }

    const mergedSkills = Array.from(new Set([...sfSkills, ...skills]));
    skills = mergedSkills; // メモリ同期
    saveDataLocally();     // ファイル保存

    res.json(mergedSkills);
});
// 🚀 学生データ送信 API
app.post('/submit', async (req, res) => {
    if (!req.session.accessToken) return res.status(401).send('未ログインです');

    // 受信データのログ出力（デバッグ用）
    console.log("🔥 [Submit] 受信したリクエストボディ:", JSON.stringify(req.body, null, 2));

    const student_Name = req.body.studentName || req.body.student_Name;
    let student_number = req.body.studentNumber || req.body.student_number;
    const firstChoice = req.body.firstChoice;
    const secondChoice = req.body.secondChoice;
    const thirdChoice = req.body.thirdChoice;
    const firstChoiceReason = req.body.firstChoiceReason;
    const secondChoiceReason = req.body.secondChoiceReason;
    const thirdChoiceReason = req.body.thirdChoiceReason;
    const notes = req.body.notes;
    const skillsData = req.body.skills;

    let rawEvaluation = req.body.skillEvaluationJson || req.body.Skill_Evaluation_JSON__c;
    let compactJsonString = '[]';

    if (rawEvaluation) {
        try {
            const evalObj = (typeof rawEvaluation === 'string') ? JSON.parse(rawEvaluation) : rawEvaluation;
            const valuesOnly = Object.values(evalObj);
            compactJsonString = JSON.stringify(valuesOnly);
        } catch (e) {
            console.error('JSON変換エラー:', e.message);
        }
    }

    if (student_number) {
        student_number = student_number.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0));
    }

    // Salesforce送信用ペイロード
    const payload = {
        "Student_Number__c": student_number,
        "Student_Name__c": student_Name,
        "FirstChoice__c": firstChoice,
        "SecondChoice__c": secondChoice,
        "ThirdChoice__c": thirdChoice,
        "FirstChoice_Reason__c": firstChoiceReason,
        "SecondChoice_Reason__c": secondChoiceReason,
        "ThirdChoice_Reason__c": thirdChoiceReason,
        "Notes__c": notes,
        "Skill_Evaluation_JSON__c": compactJsonString,
        "Skill__c": Array.isArray(req.body.skills) ? req.body.skills.join(';') : req.body.skills
    };

    // 送信直前のPayloadログ（ここが一番重要です）
    console.log("🚀 [Submit] Salesforceへ送信するペイロード:", JSON.stringify(payload, null, 2));

    const createRecordUrl = `${req.session.instanceUrl}/services/data/v58.0/sobjects/Skill_Wish__c/`;

    try {
        const response = await axios.post(createRecordUrl, payload, {
            headers: {
                'Authorization': `Bearer ${req.session.accessToken}`,
                'Content-Type': 'application/json'
            }
        });
        console.log("✅ [Submit] Salesforce登録成功:", response.data);

        res.send(`
            <div style="max-width:600px; margin:50px auto; font-family:sans-serif; text-align:center; padding:30px; border-radius:8px; box-shadow:0 2px 4px rgba(0,0,0,0.1); background:white;">
                <h1 style="color: green; margin-bottom:15px;">🎉 送信大成功！！！</h1>
                <p>データがSalesforceに登録されました。</p>
                <a href="/" style="background:#4bca81; color:white; padding:12px 24px; text-decoration:none; border-radius:4px; font-weight:bold; display:inline-block;">トップへ戻る</a>
            </div>
        `);
    } catch (err) {
        // エラー詳細をターミナルに全て出力
        console.error("❌ [Submit] Salesforce登録失敗。エラー内容:");
        if (err.response) {
            console.error("ステータスコード:", err.response.status);
            console.error("レスポンスデータ:", JSON.stringify(err.response.data, null, 2));
        } else {
            console.error("エラーメッセージ:", err.message);
        }

        const errorResponse = err.response ? err.response.data : [];
        const errorCode = Array.isArray(errorResponse) ? (errorResponse[0]?.errorCode || "UNKNOWN") : "UNKNOWN";
        const errorMessage = Array.isArray(errorResponse) ? (errorResponse[0]?.message || err.message) : err.message;

        res.send(`
            <div style="max-width:600px; margin:50px auto; font-family:sans-serif; padding:30px; border-radius:8px; box-shadow:0 2px 4px rgba(0,0,0,0.1); background:#fff1f0; border: 2px solid red;">
                <h2 style="color: red; margin-top:0;">⚠️ エラーが発生しました</h2>
                <div style="font-family:monospace; white-space:pre-wrap;">
                    <strong>エラーコード:</strong> ${errorCode}<br>
                    <strong>詳細:</strong> ${errorMessage}
                </div>
                <br>
                <a href="/" style="background:#0070d2; color:white; padding:10px 20px; text-decoration:none; border-radius:4px; font-weight:bold; display:inline-block;">やり直す</a>
            </div>
        `);
    }
});

// ==========================================
// 👑 管理者用 API 機能
// ==========================================

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        req.session.isAdmin = true;
        res.json({ success: true, message: "ログイン成功" });
    } else {
        res.status(401).json({ success: false, message: "IDまたはパスワードが違います" });
    }
});

function requireAdmin(req, res, next) {
    if (req.session.isAdmin) {
        next();
    } else {
        res.status(403).json({ error: "アクセス権限がありません。ログインしてください。" });
    }
}

app.get('/api/admin/check', (req, res) => {
    res.json({ 
        authenticated: !!req.session.isAdmin,
        sfConnected: !!req.session.accessToken 
    });
});

app.post('/api/admin/logout', (req, res) => {
    req.session.isAdmin = false;
    res.json({ success: true });
});



// ----------------------------------------------------
// 🛠️ Tooling API ヘルパー関数 (スキル追加用・確定版)
// ----------------------------------------------------
async function addSkillPicklistValueToSalesforce(instanceUrl, accessToken, newSkillName) {
    const headers = { 
        'Authorization': `Bearer ${accessToken}`, 
        'Content-Type': 'application/json' 
    };

    const query = `SELECT Id, DeveloperName, TableEnumOrId, EntityDefinition.QualifiedApiName, Metadata FROM CustomField WHERE DeveloperName = 'Skill' AND EntityDefinition.QualifiedApiName = 'Skill_Wish__c'`;
    const queryUrl = `${instanceUrl}/services/data/v58.0/tooling/query?q=${encodeURIComponent(query)}`;

    console.log('[Tooling API] スキル追加用：項目情報を検索中...');
    const queryRes = await axios.get(queryUrl, { headers });

    if (!queryRes.data.records || queryRes.data.records.length === 0) {
        throw new Error("Salesforce 上で Skill_Wish__c.Skill__c 項目が見つかりませんでした。");
    }

    const fieldRecord = queryRes.data.records[0];
    const fieldId = fieldRecord.Id;
    let metadata = fieldRecord.Metadata || {};

    // 1. 必須メタデータ属性の明示的設定
    metadata.label = metadata.label || "希望スキル";
    metadata.type = "MultiselectPicklist";
    metadata.visibleLines = metadata.visibleLines || 4; // 必須項目（行数）

    // 2. 値セットの整理
    if (!metadata.valueSet) metadata.valueSet = {};
    if (!metadata.valueSet.valueSetDefinition) {
        metadata.valueSet.valueSetDefinition = { sorted: false, value: [] };
    }

    let existingValues = metadata.valueSet.valueSetDefinition.value || [];
    if (!Array.isArray(existingValues)) {
        existingValues = [existingValues];
    }

    const alreadyExists = existingValues.some(v => v.label === newSkillName || v.valueName === newSkillName);

    if (!alreadyExists) {
        existingValues.push({
            color: null,
            default: false,
            description: null,
            isActive: true,
            label: newSkillName,
            valueName: newSkillName
        });

        metadata.valueSet.valueSetDefinition.value = existingValues;

        // 不要な相互排他プロパティを削除
        delete metadata.valueSet.valueSettings;
        delete metadata.valueSet.valueSetName;

        // 送信ペイロードの作成
        const updateUrl = `${instanceUrl}/services/data/v58.0/tooling/sobjects/CustomField/${fieldId}`;
        console.log(`[Tooling API] Field ID: ${fieldId} に「${newSkillName}」を追加中... (visibleLines: ${metadata.visibleLines})`);
        
        await axios.patch(updateUrl, { Metadata: metadata }, { headers });
        console.log(`🎉 [Tooling API] Salesforce のスキル選択肢「${newSkillName}」を追加しました！`);
    }
}

// ----------------------------------------------------
// 🛠️ Tooling API ヘルパー関数 (スキル削除用・確定版)
// ----------------------------------------------------
async function removeSkillPicklistValueFromSalesforce(instanceUrl, accessToken, targetSkillName) {
    const headers = { 
        'Authorization': `Bearer ${accessToken}`, 
        'Content-Type': 'application/json' 
    };

    const query = `SELECT Id, DeveloperName, TableEnumOrId, EntityDefinition.QualifiedApiName, Metadata FROM CustomField WHERE DeveloperName = 'Skill' AND EntityDefinition.QualifiedApiName = 'Skill_Wish__c'`;
    const queryUrl = `${instanceUrl}/services/data/v58.0/tooling/query?q=${encodeURIComponent(query)}`;

    console.log('[Tooling API] スキル削除用：項目情報を検索中...');
    const queryRes = await axios.get(queryUrl, { headers });

    if (!queryRes.data.records || queryRes.data.records.length === 0) {
        throw new Error("Salesforce 上で Skill_Wish__c.Skill__c 項目が見つかりませんでした。");
    }

    const fieldRecord = queryRes.data.records[0];
    const fieldId = fieldRecord.Id;
    let metadata = fieldRecord.Metadata || {};

    // 1. 必須メタデータ属性の明示的設定（ここを強制作成します）
    metadata.label = metadata.label || "希望スキル";
    metadata.type = "MultiselectPicklist";
    metadata.visibleLines = metadata.visibleLines || 4; // 必須項目（行数）

    if (metadata.valueSet && metadata.valueSet.valueSetDefinition && metadata.valueSet.valueSetDefinition.value) {
        let existingValues = metadata.valueSet.valueSetDefinition.value;
        if (!Array.isArray(existingValues)) {
            existingValues = [existingValues];
        }

        const newValues = existingValues.filter(v => v.label !== targetSkillName && v.valueName !== targetSkillName);

        if (newValues.length !== existingValues.length) {
            metadata.valueSet.valueSetDefinition.value = newValues;

            // 不要な相互排他プロパティを削除
            delete metadata.valueSet.valueSettings;
            delete metadata.valueSet.valueSetName;

            const updateUrl = `${instanceUrl}/services/data/v58.0/tooling/sobjects/CustomField/${fieldId}`;
            console.log(`[Tooling API] Field ID: ${fieldId} から「${targetSkillName}」を削除中... (visibleLines: ${metadata.visibleLines})`);

            await axios.patch(updateUrl, { Metadata: metadata }, { headers });
            console.log(`🎉 [Tooling API] Salesforce からスキル「${targetSkillName}」を削除しました！`);
        }
    }
}

// ----------------------------------------------------
// 🛠️ Tooling API ヘルパー関数 (病院用)
// ----------------------------------------------------
async function addPicklistValueToSalesforce(instanceUrl, accessToken, newHospitalName) {
    const headers = { 
        'Authorization': `Bearer ${accessToken}`, 
        'Content-Type': 'application/json' 
    };

    const query = `SELECT Id, DeveloperName, TableEnumOrId, EntityDefinition.QualifiedApiName, Metadata FROM CustomField WHERE DeveloperName = 'FirstChoice' AND EntityDefinition.QualifiedApiName = 'Skill_Wish__c'`;
    const queryUrl = `${instanceUrl}/services/data/v58.0/tooling/query?q=${encodeURIComponent(query)}`;

    console.log('[Tooling API] 病院追加用：項目情報を検索中...');
    const queryRes = await axios.get(queryUrl, { headers });

    if (!queryRes.data.records || queryRes.data.records.length === 0) {
        throw new Error("Salesforce 上で Skill_Wish__c.FirstChoice__c 項目が見つかりませんでした。");
    }

    const fieldRecord = queryRes.data.records[0];
    const fieldId = fieldRecord.Id;
    let metadata = fieldRecord.Metadata || {};

    if (!metadata.label) metadata.label = "第1希望";
    if (!metadata.type) metadata.type = "Picklist";

    if (!metadata.valueSet) metadata.valueSet = {};
    if (!metadata.valueSet.valueSetDefinition) {
        metadata.valueSet.valueSetDefinition = { sorted: false, value: [] };
    }

    let existingValues = metadata.valueSet.valueSetDefinition.value || [];
    if (!Array.isArray(existingValues)) {
        existingValues = [existingValues];
    }

    const alreadyExists = existingValues.some(v => v.label === newHospitalName || v.valueName === newHospitalName);

    if (!alreadyExists) {
        existingValues.push({
            color: null,
            default: false,
            description: null,
            isActive: true,
            label: newHospitalName,
            valueName: newHospitalName
        });

        metadata.valueSet.valueSetDefinition.value = existingValues;

        delete metadata.valueSet.valueSettings;
        delete metadata.valueSet.valueSetName;

        const updateUrl = `${instanceUrl}/services/data/v58.0/tooling/sobjects/CustomField/${fieldId}`;
        console.log(`[Tooling API] Field ID: ${fieldId} に新しい病院選択肢「${newHospitalName}」を更新送信中...`);
        
        await axios.patch(updateUrl, { Metadata: metadata }, { headers });
        console.log(`🎉 [Tooling API] Salesforce の病院選択肢「${newHospitalName}」を追加・更新しました！`);
    }
}

async function removePicklistValueFromSalesforce(instanceUrl, accessToken, targetHospitalName) {
    const headers = { 
        'Authorization': `Bearer ${accessToken}`, 
        'Content-Type': 'application/json' 
    };

    const query = `SELECT Id, DeveloperName, TableEnumOrId, EntityDefinition.QualifiedApiName, Metadata FROM CustomField WHERE DeveloperName = 'FirstChoice' AND EntityDefinition.QualifiedApiName = 'Skill_Wish__c'`;
    const queryUrl = `${instanceUrl}/services/data/v58.0/tooling/query?q=${encodeURIComponent(query)}`;

    console.log('[Tooling API] 病院削除用：項目情報を検索中...');
    const queryRes = await axios.get(queryUrl, { headers });

    if (!queryRes.data.records || queryRes.data.records.length === 0) {
        throw new Error("Salesforce 上で Skill_Wish__c.FirstChoice__c 項目が見つかりませんでした。");
    }

    const fieldRecord = queryRes.data.records[0];
    const fieldId = fieldRecord.Id;
    let metadata = fieldRecord.Metadata || {};

    if (!metadata.label) metadata.label = "第1希望";
    if (!metadata.type) metadata.type = "Picklist";

    if (metadata.valueSet && metadata.valueSet.valueSetDefinition && metadata.valueSet.valueSetDefinition.value) {
        let existingValues = metadata.valueSet.valueSetDefinition.value;
        if (!Array.isArray(existingValues)) {
            existingValues = [existingValues];
        }

        const newValues = existingValues.filter(v => v.label !== targetHospitalName && v.valueName !== targetHospitalName);

        if (newValues.length !== existingValues.length) {
            metadata.valueSet.valueSetDefinition.value = newValues;

            delete metadata.valueSet.valueSettings;
            delete metadata.valueSet.valueSetName;

            const updateUrl = `${instanceUrl}/services/data/v58.0/tooling/sobjects/CustomField/${fieldId}`;
            console.log(`[Tooling API] Field ID: ${fieldId} から病院選択肢「${targetHospitalName}」を削除中...`);

            await axios.patch(updateUrl, { Metadata: metadata }, { headers });
            console.log(`🎉 [Tooling API] Salesforce から病院選択肢「${targetHospitalName}」を削除しました！`);
        }
    }
}

// ----------------------------------------------------
// 💉 スキル追加/削除 API (管理者用) 【★改修】
// ----------------------------------------------------
app.post('/api/admin/skills', requireAdmin, async (req, res) => {
    const { name } = req.body;
    if (!name || name.trim() === "") {
        return res.status(400).json({ error: 'スキル名を入力してください。' });
    }
    
    const cleanName = name.trim();

    if (req.session.accessToken && req.session.instanceUrl) {
        try {
            await addSkillPicklistValueToSalesforce(req.session.instanceUrl, req.session.accessToken, cleanName);
        } catch (err) {
            const errorDetail = err.response?.data || err.message;
            console.error('❌ [Tooling API スキル追加エラー]:', JSON.stringify(errorDetail, null, 2));

            return res.status(500).json({ 
                error: "ローカルメモリへの追加は完了しましたが、Salesforceへのスキル選択肢追加に失敗しました。",
                detail: errorDetail 
            });
        }
    }

    if (!skills.includes(cleanName)) {
        skills.push(cleanName);
        saveDataLocally(); // ファイル保存
    }

    res.json({ success: true, skills });
});

app.delete('/api/admin/skills', requireAdmin, async (req, res) => {
    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ error: "削除対象のスキル名が指定されていません" });
    }

    if (req.session.accessToken && req.session.instanceUrl) {
        try {
            await removeSkillPicklistValueFromSalesforce(req.session.instanceUrl, req.session.accessToken, name);
        } catch (err) {
            const errorDetail = err.response?.data || err.message;
            console.error('❌ [Tooling API スキル削除エラー]:', JSON.stringify(errorDetail, null, 2));

            return res.status(500).json({ 
                error: "ローカルからの削除は完了しましたが、Salesforceのスキル選択肢削除に失敗しました。",
                detail: errorDetail 
            });
        }
    }

    skills = skills.filter(s => s !== name);
    saveDataLocally(); // ファイル保存

    res.json({ success: true, skills });
});

// 🏥 実習先追加/削除 API (管理者用)
app.post('/api/admin/hospitals', requireAdmin, async (req, res) => {
    const { name } = req.body;
    if (!name || name.trim() === "") {
        return res.status(400).json({ error: "名前が正しくありません" });
    }
    const cleanName = name.trim();
    
    if (req.session.accessToken && req.session.instanceUrl) {
        try {
            await addPicklistValueToSalesforce(req.session.instanceUrl, req.session.accessToken, cleanName);
        } catch (err) {
            const errorDetail = err.response?.data || err.message;
            console.error('❌ [Tooling API 病院追加エラー]:', JSON.stringify(errorDetail, null, 2));

            return res.status(500).json({ 
                error: "ローカルメモリへの追加は完了しましたが、Salesforceへの選択肢追加に失敗しました。",
                detail: errorDetail 
            });
        }
    }

    if (!customHospitals.includes(cleanName)) {
        customHospitals.push(cleanName);
        saveDataLocally(); // ファイル保存
    }

    res.json({ success: true, hospitals: customHospitals });
});

app.delete('/api/admin/hospitals', requireAdmin, async (req, res) => {
    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ error: "削除対象の名前が指定されていません" });
    }

    if (req.session.accessToken && req.session.instanceUrl) {
        try {
            await removePicklistValueFromSalesforce(req.session.instanceUrl, req.session.accessToken, name);
        } catch (err) {
            const errorDetail = err.response?.data || err.message;
            console.error('❌ [Tooling API 病院削除エラー]:', JSON.stringify(errorDetail, null, 2));

            return res.status(500).json({ 
                error: "ローカルからの削除は完了しましたが、Salesforceの選択肢削除に失敗しました。",
                detail: errorDetail 
            });
        }
    }

    customHospitals = customHospitals.filter(h => h !== name);
    saveDataLocally(); // ファイル保存

    res.json({ success: true, hospitals: customHospitals });
});


// 🔍 【改修】指定年度・新着データのみを対象にした学生データ取得 API
app.get('/api/admin/students', requireAdmin, async (req, res) => {
    if (!req.session.accessToken || !req.session.instanceUrl) {
        return res.status(401).json({ error: "Salesforceとの連携がされていません。" });
    }

    const { searchNumber, academicYear } = req.query;
    
    // 基本のクエリ
    let query = `SELECT Id, Student_Number__c, Student_Name__c, FirstChoice__c, FirstChoice_Reason__c, SecondChoice__c, SecondChoice_Reason__c, ThirdChoice__c, ThirdChoice_Reason__c, Skill__c, Skill_Evaluation_JSON__c, Notes__c, CreatedDate FROM Skill_Wish__c`;
    
    let conditions = [];

    // 特定の学籍番号で絞り込む場合
    if (searchNumber && searchNumber.trim() !== "") {
        const cleanNum = searchNumber.trim()
            .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
            .replace(/'/g, "\\'");
        conditions.push(`Student_Number__c = '${cleanNum}'`);
    }

    // ★ 【新機能】もし年度や「リセット後のデータ」で絞り込みたい場合
    // 例: リセット時にサーバー側に保存した「年度開始日（ResetDate）」以降のデータだけを取る場合
    if (global.currentAcademicYearStart) {
        conditions.push(`CreatedDate >= ${global.currentAcademicYearStart}`);
    }

    if (conditions.length > 0) {
        query += ` WHERE ` + conditions.join(' AND ');
    }
    
    query += ` ORDER BY CreatedDate DESC LIMIT 500`;

    try {
        const queryUrl = `${req.session.instanceUrl}/services/data/v58.0/query?q=${encodeURIComponent(query)}`;
        const response = await axios.get(queryUrl, {
            headers: { 'Authorization': `Bearer ${req.session.accessToken}` }
        });
        res.json(response.data.records);
    } catch (err) {
        console.error('SOQLデータ取得エラー:', err.message);
        res.status(500).json({ error: "Salesforceからのデータ取得に失敗しました。" });
    }
});

// ⚙️ 新年度リセット API（完全に新しいスタートを切る）
app.post('/api/admin/reset-year', requireAdmin, (req, res) => {
    customHospitals = [];
    skills = [];
    studentMaster = [];
    
    // ★ リセットした瞬間を「新年度の起点（ISO8601形式）」として記録する
    global.currentAcademicYearStart = new Date().toISOString();
    
    // ★ ここで必ずファイルに保存する（再起動しても消えないようにする）
    saveDataLocally();
    
    console.log(`🧹 新年度データをリセットしました。起点日時: ${global.currentAcademicYearStart}`);
    
    res.json({ 
        success: true, 
        message: "新年度データとしてリセットしました。これ以降に提出されたデータのみが集計対象になります。",
        resetTime: global.currentAcademicYearStart
    });
});

// 📈 企業（実習先）別の希望集中度・定員チェック用 集計 API
app.get('/api/admin/hospital-stats', requireAdmin, async (req, res) => {
    if (!req.session.accessToken || !req.session.instanceUrl) {
        return res.status(401).json({ error: "Salesforceとの連携がされていません。" });
    }

    try {
        // 1. 該当する期間（新年度の起点以降）の全希望調査データを取得
        let query = `SELECT FirstChoice__c, SecondChoice__c, ThirdChoice__c FROM Skill_Wish__c`;
        if (global.currentAcademicYearStart) {
            query += ` WHERE CreatedDate >= ${global.currentAcademicYearStart}`;
        }

        const queryUrl = `${req.session.instanceUrl}/services/data/v58.0/query?q=${encodeURIComponent(query)}`;
        const response = await axios.get(queryUrl, {
            headers: { 'Authorization': `Bearer ${req.session.accessToken}` }
        });

        const records = response.data.records || {};

        // 2. 実習先のリスト（マスタまたは既存の選択肢）を取得
        // 先ほどの /api/hospitals と同じロジックで全実習先を洗い出す
        let allHospitals = new Set([...customHospitals]);
        // 必要に応じてPicklistからも取得可能ですが、ここでは簡易的に集計用マップを作成します

        const stats = {};

        // 初期化
        // records から出てきた病院名、または登録済み病院名をすべて拾う
        records.forEach(rec => {
            [rec.FirstChoice__c, rec.SecondChoice__c, rec.ThirdChoice__c].forEach(h => {
                if (h) allHospitals.add(h);
            });
        });

        allHospitals.forEach(h => {
            stats[h] = {
                hospitalName: h,
                firstCount: 0,
                secondCount: 0,
                thirdCount: 0,
                totalScore: 0 // 例: 第1希望=3点, 第2=2点, 第3=1点 などの集中度計算用
            };
        });

        // 3. 集計ロジックの実行
        records.forEach(rec => {
            const f1 = rec.FirstChoice__c;
            const f2 = rec.SecondChoice__c;
            const f3 = rec.ThirdChoice__c;

            if (f1 && stats[f1]) {
                stats[f1].firstCount += 1;
                stats[f1].totalScore += 3;
            }
            if (f2 && stats[f2]) {
                stats[f2].secondCount += 1;
                stats[f2].totalScore += 2;
            }
            if (f3 && stats[f3]) {
                stats[f3].thirdCount += 1;
                stats[f3].totalScore += 1;
            }
        });

        res.json({
            totalSubmissions: records.length,
            stats: Object.values(stats)
        });

    } catch (err) {
        console.error('企業別集計エラー:', err.message);
        res.status(500).json({ error: "企業別の集計に失敗しました。" });
    }
});

app.listen(3000, () => console.log('🚀 サーバー起動完了: http://localhost:3000'));