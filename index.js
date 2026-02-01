require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http'); 
const { Server } = require("socket.io"); 
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// --- API РОУТЫ ---
app.get('/', (req, res) => res.send('Glass API v35.0'));

app.get('/api/profile/:id', async (req, res) => {
    const { id } = req.params;
    const { data, error } = await supabase.from('users').select('*').eq('telegram_id', id).single();
    if (error) return res.status(200).json({});
    res.json(data);
});

app.post('/save-stat', async (req, res) => {
    const { user_id, username, photo_url, game_type, score } = req.body;
    try {
        let { data: user } = await supabase.from('users').select('*').eq('telegram_id', user_id).single();
        const updateData = { username: username, photo_url: photo_url };
        updateData[game_type] = score;
        if (!user) {
            await supabase.from('users').insert({ telegram_id: user_id, ...updateData });
        } else {
            // Определяем тип сравнения: меньше лучше (время сапёра) или больше лучше (всё остальное)
            const isTime = game_type.includes('best') && game_type.includes('saper');
            const currentScore = user[game_type];
            let isRecord = false;
            if (currentScore === null || currentScore === undefined) isRecord = true;
            else if (isTime) { if (score < currentScore) isRecord = true; }
            else { if (score > currentScore) isRecord = true; }
            if (isRecord) await supabase.from('users').update(updateData).eq('telegram_id', user_id);
            else await supabase.from('users').update({ username: username, photo_url: photo_url }).eq('telegram_id', user_id);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/leaderboard', async (req, res) => {
    const { category } = req.query;
    // Добавлены tower_best и tower_combo
    const allowed = [
        'saper_total', 'saper_wins', 'saper_best_6', 'saper_best_8', 'saper_best_10', 'saper_best_15', 
        'checkers_total', 'checkers_wins_pve', 
        'bb_total_games', 'bb_best_score', 
        'sudoku_wins',
        'tower_best', 'tower_combo'
    ];
    if (!allowed.includes(category)) return res.json([]); 
    const isTime = category.includes('best') && category.includes('saper');
    const { data, error } = await supabase.from('users').select(`telegram_id, username, photo_url, ${category}`).not(category, 'is', null).order(category, { ascending: isTime }).limit(50);
    if (error) return res.json([]);
    const result = data.map(u => ({ user_id: u.telegram_id, username: u.username, photo_url: u.photo_url, score: u[category] }));
    res.json(result);
});

// --- SOCKET.IO ЛОГИКА (Только шашки) ---
const rooms = new Map();

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Создание игры (только шашки)
    socket.on('create_game', ({ username, photo_url }) => {
        let roomCode = Math.floor(10000 + Math.random() * 90000).toString();
        while(rooms.has(roomCode)) { roomCode = Math.floor(10000 + Math.random() * 90000).toString(); }
        
        socket.join(roomCode);
        
        rooms.set(roomCode, {
            players: [{ 
                id: socket.id, 
                name: username, 
                avatar: photo_url,
                color: 'white'
            }],
            status: 'waiting'
        });

        socket.emit('game_created', { roomCode, color: 'white' });
        console.log(`Room ${roomCode} created by ${username}`);
    });

    // Вход в игру
    socket.on('join_game', ({ roomCode, userData }) => {
        const room = rooms.get(roomCode);
        if (!room) { socket.emit('error_message', 'Комната не найдена'); return; }
        if (room.players.length >= 2) { socket.emit('error_message', 'Комната переполнена'); return; }

        socket.join(roomCode);
        
        const newPlayer = { 
            id: socket.id, 
            name: userData.username, 
            avatar: userData.photo_url,
            color: 'black'
        };

        room.players.push(newPlayer);
        
        // Старт игры
        io.to(room.players[0].id).emit('start_game', { 
            opponent: { name: newPlayer.name, avatar: newPlayer.avatar }, 
            color: 'white' 
        });
        io.to(newPlayer.id).emit('start_game', { 
            opponent: { name: room.players[0].name, avatar: room.players[0].avatar }, 
            color: 'black' 
        });
    });

    // Ход в шашках
    socket.on('move', ({ roomCode, move }) => {
        if (rooms.has(roomCode)) socket.to(roomCode).emit('opponent_move', move);
    });

    // Конец игры
    socket.on('game_over', ({ roomCode, winner }) => {
        io.to(roomCode).emit('game_finished', { winner });
        setTimeout(() => rooms.delete(roomCode), 5000);
    });

    // Отключение
    socket.on('disconnect', () => {
        rooms.forEach((room, code) => {
            const index = room.players.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                room.players.splice(index, 1);
                socket.to(code).emit('opponent_disconnected');
                rooms.delete(code);
            }
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Glass API v35.0 running on port ${PORT}`));