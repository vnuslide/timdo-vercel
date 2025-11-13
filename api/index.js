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
    
    // Google Drive
    DRIVE_FOLDER_ID: process.env.drive_folder_id, 
    
    // OpenRouter
    OPENROUTER_KEYS: [process.env.openrouter_key1],
    HOST: 'https://open.larksuite.com',
    TZ: 'Asia/Ho_Chi_Minh',
    
    // Service Account – LẤY TỪ ENV
    SERVICE_ACCOUNT_KEY: JSON.parse(process.env.service_account_key_json || "{}")
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

// (HÀM TẢI ẢNH BẰNG DRIVE API)
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
            requestBody: { 
                name: fileName, 
                parents: [CFG.DRIVE_FOLDER_ID] // ID Thư mục Drive
            },
            media: { mimeType: mimeType, body: bufferStream }
        });
        
        const fileId = response.data.id;
        // Set quyền public
        await drive.permissions.create({
            fileId: fileId,
            requestBody: { role: 'reader', type: 'anyone' }
        });
        
        return `https://drive.google.com/uc?id=${fileId}`;
    } catch (e) { 
        console.error('Lỗi tải ảnh lên Drive:', e.message); 
        // (QUAN TRỌNG) Ném lỗi chi tiết ra ngoài
        throw new Error("Lỗi Google Drive API: " + e.message); 
    }
}

// --- (Các hàm CRUD và AI) ---
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

// (HÀM CONVERT DỮ LIỆU)
async function convertFormDataToLarkFields_(data) {
    const imageUrls = [];
    if (data.img1_base64) {
        // GỌI HÀM DRIVE
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

// --- (Các hàm AI) ---
let apiKeyIndex = 0;
function getNextApiKey_() {
    const keyToUse = CFG.OPENROUTER_KEYS[apiKeyIndex];
    apiKeyIndex = (apiKeyIndex + 1) % CFG.OPENROUTER_KEYS.length;
    return keyToUse;
}

async function scanImageAndParseWithOpenRouter_(base64ImageData) {
    const openRouterUrl = 'https://openrouter.ai/api/v1/chat/completions';
    // (Dán PROMPT quét ảnh của bạn từ file Dothatlac Sumbit.js vào đây)
    const promptText = `Bạn là một trợ lý AI OCR chuyên nghiệp... (Dán prompt quét ảnh của bạn vào đây)`; 
    const modelToUse = "anthropic/claude-3-haiku:latest";
    const payload = {
        model: modelToUse,
        messages: [ { role: "user", content: [ { type: "text", text: promptText }, { type: "image_url", image_url: { url: base64ImageData } } ] } ],
        response_format: { "type": "json_object" }
    };
    const options = { method: 'post', url: openRouterUrl, headers: { 'Authorization': `Bearer ${getNextApiKey_()}`, 'HTTP-Referer': 'https://timdosinhvien.site', 'X-Title': 'TimDoSinhVien OCR' }, data: payload };
    const response = await axios(options);
    const jsonResponse = response.data;
    if (jsonResponse.error || !jsonResponse.choices) throw new Error("Lỗi từ OpenRouter: " + (jsonResponse.error ? jsonResponse.error.message : 'Phản hồi không hợp lệ'));
    const rawJsonString = jsonResponse.choices[0].message.content;
    const parsedData = JSON.parse(rawJsonString);
    return { success: true, name: parsedData.ten || null, dob: parsedData.ngaySinh || null, school_code: parsedData.truong || null, item_type: parsedData.loaiDo || null, moTaNgan: parsedData.moTaNgan || null, isSensitive: parsedData.isSensitive || false, text: rawJsonString };
}

async function chatWithAI_(question, filteredDataJson) {
    const openRouterUrl = 'https://openrouter.ai/api/v1/chat/completions';
    // (Dán PROMPT chatbot của bạn từ file Dothatlac Sumbit.js vào đây)
    const promptSystem = `Bạn là "Tư vấn viên AI" của trang... (Dán prompt chatbot của bạn vào đây)`; 
    const modelToUse = "anthropic/claude-3-haiku:latest";
    const payload = {
        model: modelToUse,
        messages: [ { role: "system", content: promptSystem }, { role: "user", content: "Đây là 10 tin đăng liên quan nhất (dạng JSON): \n" + filteredDataJson }, { role: "user", content: "Đây là câu hỏi của tôi: \n" + question } ]
    };
    const options = { method: 'post', url: openRouterUrl, headers: { 'Authorization': `Bearer ${getNextApiKey_()}`, 'HTTP-Referer': 'https://timdosinhvien.site', 'X-Title': 'TimDoSinhVien Chatbot' }, data: payload };
    const response = await axios(options);
    const jsonResponse = response.data;
    if (jsonResponse.error || !jsonResponse.choices) throw new Error("Lỗi từ OpenRouter (Chatbot): " + (jsonResponse.error ? jsonResponse.error.message : 'Phản hồi không hợp lệ'));
    return jsonResponse.choices[0].message.content;
}

// (APP EXPORT)
const app = express();
app.use(cors({ origin: true })); 
app.use(express.json({limit: '20mb'})); 
app.all("/", async (req, res) => {
    const params = req.method === 'GET' ? req.query : req.body;
    try {
        const action = params.action;
        const email = params.email || params.emailNguoiDang;
        const recordId = params.record_id || params.record_id_to_edit;
        
        if (!action) {
             if (req.method === 'GET' && Object.keys(params).length === 0) {
                 return res.status(200).send('API Vercel (đã chuyển sang Google Drive) đang hoạt động.');
             }
             throw new Error("Hành động (action) không được cung cấp.");
        }
        
        const isAdmin = await isUserAdmin_(email);

        switch (action) {
            case 'checkUserRole':
                if (!email) throw new Error("Cần email để checkUserRole.");
                return res.json({ success: true, isAdmin: isAdmin });
            case 'getMyPosts':
                if (!email) throw new Error("Cần email để getMyPosts.");
                let records;
                if (isAdmin) {
                    const allData = await bitableListAll_();
                    records = allData || [];
                } else {
                    records = await bitableGetRecordsByEmail_(email);
                }
                return res.json({ success: true, items: records });
            case 'getSinglePost':
                if (!email || !recordId) throw new Error("Cần email và record_id.");
                const record = await bitableGetRecord_(recordId);
                if (!isAdmin && record.fields.EmailNguoiDang !== email) {
                    throw new Error("Không có quyền: Bạn không phải chủ sở hữu của tin này.");
                }
                return res.json({ success: true, item: record });
            case 'deletePost':
                if (!email || !recordId) throw new Error("Cần email và record_id.");
                const recordToDelete = await bitableGetRecord_(recordId);
                if (!isAdmin && recordToDelete.fields.EmailNguoiDang !== email) {
                    throw new Error("Không có quyền: Bạn không phải chủ sở hữu của tin này.");
                }
                const deleteResult = await bitableDeleteRecord_(recordId);
                return res.json({ success: true, message: "Đã xóa tin thành công.", result: deleteResult });
            case 'scanImage':
                if (!email || !isAdmin) throw new Error("Không có quyền: Chỉ Admin mới được dùng tính năng quét ảnh.");
                const scanResult = await scanImageAndParseWithOpenRouter_(params.imageData);
                return res.json(scanResult);
            case 'chatWithAI':
                if (!email) throw new Error("Cần đăng nhập để chat.");
                const answer = await chatWithAI_(params.question, params.filteredData);
                return res.json({ success: true, answer: answer });
            case 'approvePost':
                if (!email || !isAdmin) throw new Error("Không có quyền: Chỉ Admin mới được duyệt tin.");
                if (!recordId) throw new Error("Thiếu record_id để duyệt.");
                await bitableUpdateRecord_(recordId, { "TrangThai": "Đã duyệt" });
                return res.json({ success: true, message: "Đã duyệt tin thành công." });
            case 'submitPost':
            case 'updatePost':
                if (!email) throw new Error("Cần phải đăng nhập (thiếu email).");
                const fields = await convertFormDataToLarkFields_(params);
                let message = "";
                if (action === 'updatePost') {
                    if (!recordId) throw new Error("Thiếu record_id để cập nhật.");
                    const existingRecord = await bitableGetRecord_(recordId);
                    if (existingRecord.fields.EmailNguoiDang !== email && !isAdmin) {
                        throw new Error("Không có quyền: Bạn không phải chủ sở hữu của tin này.");
                    }
                    await bitableUpdateRecord_(recordId, fields);
                    message = "Cập nhật tin thành công!";
                } else {
                    await bitableAddRecord_(fields);
                    message = fields.TrangThai === "Đã duyệt" ? "Đăng tin thành công! (Admin)" : "Đăng tin thành công! (Chờ duyệt)";
                }
                return res.json({ success: true, message: message });
            
            default:
                throw new Error(`Hành động (action) không xác định: ${action}`);
        }
    } catch (e) {
        console.error("Lỗi API:", e.message, "Params:", params);
        return res.status(500).json({ success: false, error: e.message });
    }
});
module.exports = app;
