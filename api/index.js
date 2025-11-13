const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { google } = require("googleapis"); // Cần thư viện này
const stream = require("stream"); // Cần thư viện này


// === KHỐI CẤU HÌNH (CFG) TỔNG ===
const CFG = {
    // Lark Base
    APP_ID: process.env.lark_app_id,
    APP_SECRET: process.env.lark_app_secret,
    BASE_TOKEN: process.env.lark_base_token,
    TABLE_ID: process.env.lark_table_id,
    USERS_TABLE_ID: process.env.lark_users_table_id,
    // Google Drive (BỊ LỖI NẾU THIẾU THẺ/SERVICE ACCOUNT)
    DRIVE_FOLDER_ID: process.env.drive_folder_id, 
    // OpenRouter
    OPENROUTER_KEYS: [process.env.openrouter_key1],
    HOST: 'https://open.larksuite.com',
    TZ: 'Asia/Ho_Chi_Minh',
    // (QUAN TRỌNG: CẦN FILE service-account-key.json NẰM TRONG THƯ MỤC API)
    SERVICE_ACCOUNT_KEY: require("./service-account-key.json") 
};

// --- (Các hàm helper) ---
let larkTokenCache = { token: null, exp: 0 };
async function getTenantAccessToken_() {
    const now = Date.now();
    if (larkTokenCache.token && now < larkTokenCache.exp) return larkTokenCache.token;
    const url = CFG.HOST + '/open-apis/auth/v3/tenant_access_token/internal';
    const payload = { app_id: CFG.APP_ID, app_secret: CFG.APP_SECRET };
    try {
        const res = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } });
        const j = res.data;
        if (j.code !== 0 || !j.tenant_access_token) throw new Error('Lark auth error: ' + (j.msg || 'Không rõ lỗi'));
        const token = j.tenant_access_token;
        const ttl = (j.expire || 3600) - 120;
        larkTokenCache = { token: token, exp: now + ttl * 1000 };
        return token;
    } catch (e) { console.error("Lỗi khi lấy token:", e.message); throw e; }
}

async function callLarkAPI(method, path, payload = null) {
    const token = await getTenantAccessToken_();
    const url = `${CFG.HOST}${path}`;
    try {
        const res = await axios({
            method: method, url: url,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: payload
        });
        const j = res.data;
        if (j.code !== 0) throw new Error(`Lark API error: ${j.msg} (Code: ${j.code})`);
        return j.data;
    } catch (e) { console.error(`Lỗi khi gọi ${method} ${path}:`, e.response ? e.response.data : e.message); throw e; }
}

// (HÀM TẢI ẢNH GÂY LỖI - ĐANG CHỜ THANH TOÁN)
function getDriveService() {
    const auth = new google.auth.GoogleAuth({
        credentials: CFG.SERVICE_ACCOUNT_KEY,
        scopes: ['https://www.googleapis.com/auth/drive.file']
    });
    return google.drive({ version: 'v3', auth });
}

async function uploadImageToDrive_(base64Data, fileName) {
    if (!base64Data || !fileName) return null;
    try {
        const drive = getDriveService();
        const mimeType = base64Data.substring(5, base64Data.indexOf(';'));
        const fileBytes = Buffer.from(base64Data.substring(base64Data.indexOf(',') + 1), 'base64');
        const bufferStream = new stream.PassThrough();
        bufferStream.end(fileBytes);
        const response = await drive.files.create({
            requestBody: { name: fileName, parents: [CFG.DRIVE_FOLDER_ID], mimeType: mimeType },
            media: { mimeType: mimeType, body: bufferStream }
        });
        const fileId = response.data.id;
        await drive.permissions.create({
            fileId: fileId,
            requestBody: { role: 'reader', type: 'anyone' }
        });
        return `https://drive.google.com/uc?id=${fileId}`;
    } catch (e) { console.error('Lỗi tải ảnh lên Drive:', e.message); return null; }
}

// --- (Các hàm CRUD và AI giữ nguyên) ---
async function bitableAddRecord_(fields) { return callLarkAPI('post', `/open-apis/bitable/v1/apps/${CFG.BASE_TOKEN}/tables/${CFG.TABLE_ID}/records`, { fields }); }
async function bitableGetRecord_(recordId) { const data = await callLarkAPI('get', `/open-apis/bitable/v1/apps/${CFG.BASE_TOKEN}/tables/${CFG.TABLE_ID}/records/${recordId}`); return data.record; }
async function bitableGetRecordsByEmail_(email) {
    const filter = `CurrentValue.[EmailNguoiDang] = "${email}"`;
    const data = await callLarkAPI('get', `/open-apis/bitable/v1/apps/${CFG.BASE_TOKEN}/tables/${CFG.TABLE_ID}/records?filter=${encodeURIComponent(filter)}`);
    return data.items || [];
}
async function bitableListAll_() {
    const token = await getTenantAccessToken_();
    let out = []; let pt = '';
    do {
        const path = `/open-apis/bitable/v1/apps/${CFG.BASE_TOKEN}/tables/${CFG.TABLE_ID}/records?page_size=200${pt ? `&page_token=${pt}` : ''}`;
        const d = await callLarkAPI('get', path);
        out = out.concat(d.items || []);
        pt = d.has_more ? d.page_token : '';
    } while (pt);
    return out;
}
async function bitableUpdateRecord_(recordId, fields) { return callLarkAPI('put', `/open-apis/bitable/v1/apps/${CFG.BASE_TOKEN}/tables/${CFG.TABLE_ID}/records/${recordId}`, { fields }); }
async function bitableDeleteRecord_(recordId) { return callLarkAPI('delete', `/open-apis/bitable/v1/apps/${CFG.BASE_TOKEN}/tables/${CFG.TABLE_ID}/records/${recordId}`); }
async function isUserAdmin_(email) {
    if (!email) return false;
    try {
        const filter = `CurrentValue.[email] = "${email}"`;
        const data = await callLarkAPI('get', `/open-apis/bitable/v1/apps/${CFG.BASE_TOKEN}/tables/${CFG.USERS_TABLE_ID}/records?filter=${encodeURIComponent(filter)}`);
        if (data && data.items && data.items.length > 0) return data.items[0].fields.IsAdmin === true;
        return false;
    } catch (e) { console.error("Lỗi khi kiểm tra Admin: " + e); return false; }
}

// (HÀM CONVERT)
async function convertFormDataToLarkFields_(data) {
    const imageUrls = [];
    if (data.img1_base64) {
        // GỌI HÀM DRIVE LỖI CŨ
        const url1 = await uploadImageToDrive_(data.img1_base64, data.img1_name); 
        if (url1) imageUrls.push(url1);
    }
    
    let sdt = null; let facebook = null;
    const lienHeInput = data.lienHe || "";
    if (lienHeInput.includes('http')) facebook = lienHeInput;
    else sdt = lienHeInput;
    let trangThaiValue = "Chờ duyệt";
    if (data.emailNguoiDang && await isUserAdmin_(data.emailNguoiDang)) {
        trangThaiValue = "Đã duyệt";
    }
    const GROUP_MAP = { "HCMIU": "IU" };
    const groupForm = data.group;
    const groupLark = GROUP_MAP[groupForm] || groupForm;
    const LOAIDO_MAP = { "GPLX (Bằng lái xe)": "GPLX", "Giấy tờ (Chung)": "Giấy tờ" };
    const loaiDoForm = data.loaiDo;
    const loaiDoLark = LOAIDO_MAP[loaiDoForm] || loaiDoForm;
    const fields = {
        "TieuDe": data.tieuDe, "MoTa": data.noiDung, "KhuVuc": data.khuVuc,
        "LoaiTin": data.dangTinLa === 'timdo' ? 'Cần tìm' : 'Nhặt được',
        "TrangThai": trangThaiValue, "LoaiDo": [ loaiDoLark ],
        "LienHe": sdt ? sdt : null, "LinkFacebook": facebook ? facebook : null,
        "EmailNguoiDang": data.emailNguoiDang || null,
        "Latitude": data.latitude || null, "Longitude": data.longitude || null
    };
    if (groupLark && groupLark.trim() !== "") fields["Group"] = [ groupLark ];
    if (imageUrls.length > 0) fields["HinhAnhURL"] = imageUrls[0];
    else if (data.keep_image_url) fields["HinhAnhURL"] = data.keep_image_url;
    else fields["HinhAnhURL"] = null;
    return fields;
}

let apiKeyIndex = 0;
function getNextApiKey_() { /* ... (Logic AI) ... */ }
async function scanImageAndParseWithOpenRouter_(base64ImageData) { /* ... (Logic AI) ... */ }
async function chatWithAI_(question, filteredDataJson) { /* ... (Logic AI) ... */ }

// (APP EXPORT)
const app = express();
app.use(cors({ origin: true })); 
app.use(express.json({limit: '20mb'})); 
app.all("/", async (req, res) => {
    // (Logic app.all giữ nguyên)
    // ...
});
module.exports = app;
