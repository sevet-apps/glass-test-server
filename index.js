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
app.get('/', (req, res) => res.send('Glass API v36.0'));

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
    const allowed = [
        'saper_total', 'saper_wins', 'saper_best_6', 'saper_best_8', 'saper_best_10', 'saper_best_15', 
        'checkers_total', 'checkers_wins_pve', 
        'bb_total_games', 'bb_best_score', 
        'sudoku_wins',
        'tower_best', 'tower_combo',
        'wordle_wins'
    ];
    if (!allowed.includes(category)) return res.json([]); 
    const isTime = category.includes('best') && category.includes('saper');
    const { data, error } = await supabase.from('users').select(`telegram_id, username, photo_url, ${category}`).not(category, 'is', null).order(category, { ascending: isTime }).limit(50);
    if (error) return res.json([]);
    const result = data.map(u => ({ user_id: u.telegram_id, username: u.username, photo_url: u.photo_url, score: u[category] }));
    res.json(result);
});

// Get user ranks for all games
app.get('/user-ranks', async (req, res) => {
    const { user_id } = req.query;
    if (!user_id) return res.json({});
    
    const categories = [
        { key: 'bb_best_score', asc: false },
        { key: 'saper_best_8', asc: true },
        { key: 'tower_best', asc: false },
        { key: 'sudoku_wins', asc: false },
        { key: 'checkers_wins_pve', asc: false },
        { key: 'wordle_wins', asc: false }
    ];
    
    const ranks = {};
    
    for (const cat of categories) {
        const { data } = await supabase
            .from('users')
            .select(`telegram_id, ${cat.key}`)
            .not(cat.key, 'is', null)
            .gt(cat.key, 0)
            .order(cat.key, { ascending: cat.asc });
        
        if (data) {
            const idx = data.findIndex(u => String(u.telegram_id) === String(user_id));
            const userEntry = data.find(u => String(u.telegram_id) === String(user_id));
            ranks[cat.key] = {
                rank: idx >= 0 ? idx + 1 : null,
                score: userEntry ? userEntry[cat.key] : null,
                total: data.length
            };
        }
    }
    
    res.json(ranks);
});

// --- REFERRAL SYSTEM ---

// Register a new referral
app.post('/register-referral', async (req, res) => {
    const { user_id, referrer_id, username, photo_url } = req.body;
    
    if (!user_id || !referrer_id) {
        return res.status(400).json({ error: 'Missing user_id or referrer_id' });
    }
    
    // Don't allow self-referral
    if (user_id === referrer_id) {
        return res.status(400).json({ error: 'Cannot refer yourself' });
    }
    
    try {
        // Check if user already exists (not a new user)
        const { data: existingUser } = await supabase
            .from('users')
            .select('telegram_id, referred_by')
            .eq('telegram_id', user_id)
            .single();
        
        // If user already exists and has a referrer, skip
        if (existingUser && existingUser.referred_by) {
            return res.json({ success: false, message: 'User already has a referrer' });
        }
        
        // Check if referrer exists
        const { data: referrer } = await supabase
            .from('users')
            .select('telegram_id')
            .eq('telegram_id', referrer_id)
            .single();
        
        if (!referrer) {
            // Create referrer if not exists
            await supabase.from('users').insert({ 
                telegram_id: referrer_id,
                referral_count: 1
            });
        } else {
            // Increment referrer's referral_count
            await supabase.rpc('increment_referral_count', { uid: referrer_id });
        }
        
        // Update or create referred user
        if (existingUser) {
            await supabase
                .from('users')
                .update({ referred_by: referrer_id })
                .eq('telegram_id', user_id);
        } else {
            await supabase.from('users').insert({
                telegram_id: user_id,
                username: username,
                photo_url: photo_url,
                referred_by: referrer_id
            });
        }
        
        res.json({ success: true });
    } catch (e) {
        console.error('Referral error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Get referral stats for a user
app.get('/referral-stats', async (req, res) => {
    const { user_id } = req.query;
    
    if (!user_id) {
        return res.json({ referral_count: 0, rank: null });
    }
    
    try {
        // Get user's referral count
        const { data: user } = await supabase
            .from('users')
            .select('referral_count')
            .eq('telegram_id', user_id)
            .single();
        
        const referralCount = user?.referral_count || 0;
        
        // Get rank (position among all users by referral_count)
        const { data: allUsers } = await supabase
            .from('users')
            .select('telegram_id, referral_count')
            .gt('referral_count', 0)
            .order('referral_count', { ascending: false });
        
        let rank = null;
        if (allUsers && referralCount > 0) {
            const idx = allUsers.findIndex(u => String(u.telegram_id) === String(user_id));
            if (idx >= 0) rank = idx + 1;
        }
        
        res.json({ referral_count: referralCount, rank: rank });
    } catch (e) {
        console.error('Referral stats error:', e);
        res.json({ referral_count: 0, rank: null });
    }
});

// Get referral leaderboard
app.get('/referral-leaderboard', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('users')
            .select('telegram_id, username, photo_url, referral_count')
            .gt('referral_count', 0)
            .order('referral_count', { ascending: false })
            .limit(50);
        
        if (error) return res.json([]);
        
        const result = data.map(u => ({
            user_id: u.telegram_id,
            username: u.username,
            photo_url: u.photo_url,
            score: u.referral_count
        }));
        
        res.json(result);
    } catch (e) {
        res.json([]);
    }
});

// --- SOCKET.IO ЛОГИКА (Шашки с таймером) ---
const rooms = new Map();
const TURN_TIME_LIMIT = 60000; // 60 секунд на ход

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Синхронизация времени - клиент отправляет ping, сервер отвечает с серверным временем
    socket.on('time_sync', (clientTime, callback) => {
        callback({ serverTime: Date.now(), clientTime: clientTime });
    });

    // Создание игры
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
            status: 'waiting',
            currentTurn: 'white',
            turnStartedAt: null,
            turnTimer: null
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
        room.status = 'playing';
        
        // Запускаем таймер для первого хода (белые)
        room.turnStartedAt = Date.now();
        startTurnTimer(roomCode);

        // Старт игры - отправляем с серверным временем начала хода
        io.to(room.players[0].id).emit('start_game', { 
            opponent: { name: newPlayer.name, avatar: newPlayer.avatar }, 
            color: 'white',
            turnStartedAt: room.turnStartedAt,
            serverTime: Date.now()
        });
        io.to(newPlayer.id).emit('start_game', { 
            opponent: { name: room.players[0].name, avatar: room.players[0].avatar }, 
            color: 'black',
            turnStartedAt: room.turnStartedAt,
            serverTime: Date.now()
        });
    });

    // Ход в шашках
    socket.on('move', ({ roomCode, move }) => {
        const room = rooms.get(roomCode);
        if (!room) return;

        // Проверяем что ходит правильный игрок
        const player = room.players.find(p => p.id === socket.id);
        if (!player || player.color !== room.currentTurn) {
            console.log(`Invalid move attempt: ${player?.color} tried to move on ${room.currentTurn}'s turn`);
            socket.emit('sync_state', { currentTurn: room.currentTurn, turnStartedAt: room.turnStartedAt, serverTime: Date.now() });
            return;
        }

        // Останавливаем текущий таймер
        if (room.turnTimer) {
            clearTimeout(room.turnTimer);
            room.turnTimer = null;
        }

        // Меняем ход
        room.currentTurn = room.currentTurn === 'white' ? 'black' : 'white';
        room.turnStartedAt = Date.now();

        // Отправляем ход сопернику с серверным временем и текущим ходом
        socket.to(roomCode).emit('opponent_move', { 
            move: move, 
            turnStartedAt: room.turnStartedAt,
            currentTurn: room.currentTurn,
            serverTime: Date.now()
        });

        // Подтверждаем ход отправителю с синхронизированным временем
        socket.emit('move_confirmed', {
            turnStartedAt: room.turnStartedAt,
            currentTurn: room.currentTurn,
            serverTime: Date.now()
        });

        // Запускаем таймер для следующего хода
        startTurnTimer(roomCode);
    });

    // Запрос синхронизации таймера (при возвращении в приложение)
    socket.on('request_sync', ({ roomCode }) => {
        const room = rooms.get(roomCode);
        if (!room || !room.turnStartedAt) return;

        socket.emit('sync_timer', { 
            turnStartedAt: room.turnStartedAt,
            currentTurn: room.currentTurn,
            serverTime: Date.now()
        });
    });

    // Игрок сообщает о своём таймауте
    socket.on('timeout', ({ roomCode }) => {
        const room = rooms.get(roomCode);
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        // Оповещаем соперника о таймауте
        socket.to(roomCode).emit('opponent_timeout');
        
        // Завершаем игру
        cleanupRoom(roomCode);
    });

    // Игрок вышел из игры (сдался)
    socket.on('player_left', ({ roomCode }) => {
        const room = rooms.get(roomCode);
        if (!room) return;

        socket.to(roomCode).emit('opponent_left');
        cleanupRoom(roomCode);
    });

    // Конец игры
    socket.on('game_over', ({ roomCode, winner }) => {
        const room = rooms.get(roomCode);
        if (!room) return;

        io.to(roomCode).emit('game_finished', { winner });
        cleanupRoom(roomCode);
    });

    // Отключение
    socket.on('disconnect', () => {
        rooms.forEach((room, code) => {
            const index = room.players.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                room.players.splice(index, 1);
                socket.to(code).emit('opponent_disconnected');
                cleanupRoom(code);
            }
        });
    });
});

// Запуск таймера хода
function startTurnTimer(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;

    room.turnStartedAt = Date.now();

    // Очищаем предыдущий таймер если есть
    if (room.turnTimer) {
        clearTimeout(room.turnTimer);
    }

    // Устанавливаем таймер на 60 секунд
    room.turnTimer = setTimeout(() => {
        const currentRoom = rooms.get(roomCode);
        if (!currentRoom) return;

        // Находим игрока, у которого вышло время
        const timedOutPlayer = currentRoom.players.find(p => p.color === currentRoom.currentTurn);
        const winner = currentRoom.players.find(p => p.color !== currentRoom.currentTurn);

        if (timedOutPlayer && winner) {
            // Сообщаем проигравшему
            io.to(timedOutPlayer.id).emit('timeout_loss');
            // Сообщаем победителю
            io.to(winner.id).emit('opponent_timeout');
        }

        cleanupRoom(roomCode);
    }, TURN_TIME_LIMIT);
}

// Очистка комнаты
function cleanupRoom(roomCode) {
    const room = rooms.get(roomCode);
    if (room) {
        if (room.turnTimer) {
            clearTimeout(room.turnTimer);
        }
        rooms.delete(roomCode);
        console.log(`Room ${roomCode} cleaned up`);
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Glass API v36.0 running on port ${PORT}`));