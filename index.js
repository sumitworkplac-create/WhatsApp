const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.urlencoded({ extended: true }));
const port = process.env.PORT || 3000;

let geminiApiKey = null; // UI se aane wali API key yahan save hogi
let qrCodeUrl = null;
let botReady = false;

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

client.on('qr', async (qr) => {
    qrCodeUrl = await qrcode.toDataURL(qr);
});

client.on('ready', () => {
    botReady = true;
    console.log('Bot is ready!');
});

// Human-like Wait Function
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

client.on('message', async message => {
    if (message.fromMe || !geminiApiKey) return;

    try {
        const chat = await message.getChat();
        
        // 1. Padhne ka natak (2 se 5 second wait)
        const readDelay = Math.floor(Math.random() * 3000) + 2000;
        await delay(readDelay);
        
        // 2. Blue Tick Dikhana (Mark as read)
        await chat.sendSeen();

        // 3. AI se reply sochna
        const ai = new GoogleGenAI({ apiKey: geminiApiKey });
        const context = chat.isGroup ? "group chat mein doston ke sath" : "personal chat mein";
        const prompt = `Tum mere ek human dost ho. Ye baat ${context} ho rahi hai. 
        Message: "${message.body}". 
        Ek chhota, natural, aur hinglish reply do. Aisa lage ki ek asli insaan bina soche normally type kar raha hai.`;
        
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt
        });
        const replyText = response.text;

        // 4. Typing status dikhana
        await chat.sendStateTyping();

        // 5. Type karne ka delay (Text jitna lamba, utna zyada time - max 5 sec)
        const typingTime = Math.min(replyText.length * 50, 5000);
        await delay(typingTime);

        // 6. Final message bhejna (Group ho ya normal, dono me jayega)
        await message.reply(replyText);

        // Typing status clear karna (optional, par safe hai)
        await chat.clearState();

    } catch (error) {
        console.error('Error:', error);
    }
});

// --- UI ROUTING ---

// Main Dashboard (API Key form ya QR/Pairing form)
app.get('/', (req, res) => {
    if (!geminiApiKey) {
        return res.send(`
            <div style="text-align: center; font-family: sans-serif; margin-top: 50px;">
                <h2>Setup: Gemini API Key Daalein</h2>
                <form action="/save-api" method="POST">
                    <input type="password" name="apikey" placeholder="Enter API Key here" required style="padding: 10px; width: 300px;">
                    <button type="submit" style="padding: 10px; background: #007bff; color: white; border: none; cursor: pointer;">Save & Lock</button>
                </form>
            </div>
        `);
    }

    if (botReady) {
        return res.send("<h2 style='color: green; text-align: center;'>✅ Bot successfully connect ho gaya hai aur chal raha hai!</h2>");
    }

    res.send(`
        <div style="text-align: center; font-family: sans-serif; margin-top: 50px;">
            <p style="color: green;">API Key Saved! 🔒</p>
            ${qrCodeUrl ? `
                <h2>Option 1: QR Scan Karein</h2>
                <img src="${qrCodeUrl}" style="width: 250px; height: 250px;" />
            ` : '<h3>QR Load ho raha hai... Refresh karein</h3>'}
            <hr>
            <h2>Option 2: Number se Pair Karein</h2>
            <form action="/pair" method="POST">
                <input type="text" name="phone" placeholder="919876543210" required style="padding: 10px;">
                <button type="submit" style="padding: 10px; background: #25D366; color: white; border: none;">Get Code</button>
            </form>
        </div>
    `);
});

// API Key Save Karne ka route
app.post('/save-api', (req, res) => {
    geminiApiKey = req.body.apikey;
    client.initialize(); // API key daalne ke baad hi WhatsApp start hoga
    res.redirect('/'); // Wapas home page par bhej dega jahan QR dikhega
});

// Pairing Code Route
app.post('/pair', async (req, res) => {
    try {
        const code = await client.requestPairingCode(req.body.phone);
        res.send(`<div style="text-align: center; margin-top: 50px;"><h2>Aapka Code:</h2><h1 style="color: #25D366; letter-spacing: 5px;">${code}</h1><a href="/">Back</a></div>`);
    } catch (err) {
        res.send(`Error: ${err.message}`);
    }
});

app.listen(port, () => console.log(`Server running on ${port}`));
