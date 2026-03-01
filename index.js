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

// Telegram Bot Token for subscription check
const BOT_TOKEN = process.env.BOT_TOKEN;
const REQUIRED_CHANNEL = process.env.REQUIRED_CHANNEL || '@spark_games_news'; // Замени на свой канал

// --- API РОУТЫ ---
app.get('/', (req, res) => res.send('Glass API v37.0'));

// Check if user is subscribed to the required channel
app.get('/check-subscription', async (req, res) => {
    const { user_id } = req.query;
    
    if (!user_id) {
        return res.json({ subscribed: false, error: 'No user_id provided' });
    }
    
    if (!BOT_TOKEN) {
        console.log('BOT_TOKEN not set, skipping subscription check');
        return res.json({ subscribed: true }); // Skip check if no token
    }
    
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${REQUIRED_CHANNEL}&user_id=${user_id}`;
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.ok) {
            const status = data.result.status;
            // member, administrator, creator = subscribed
            // left, kicked, restricted = not subscribed
            const subscribed = ['member', 'administrator', 'creator'].includes(status);
            return res.json({ subscribed, status });
        } else {
            console.log('Telegram API error:', data);
            // If error (e.g., user never interacted with bot), assume not subscribed
            return res.json({ subscribed: false, error: data.description });
        }
    } catch (e) {
        console.error('Subscription check error:', e);
        return res.json({ subscribed: true }); // On error, allow access
    }
});

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
    
    console.log('Register referral request:', { user_id, referrer_id, username });
    
    if (!user_id || !referrer_id) {
        return res.status(400).json({ error: 'Missing user_id or referrer_id' });
    }
    
    // Don't allow self-referral
    if (user_id === referrer_id) {
        return res.status(400).json({ error: 'Cannot refer yourself' });
    }
    
    try {
        // Check if user already exists and has a referrer
        const { data: existingUser } = await supabase
            .from('users')
            .select('telegram_id, referred_by')
            .eq('telegram_id', user_id)
            .single();
        
        // If user already has a referrer, skip
        if (existingUser && existingUser.referred_by) {
            console.log('User already has a referrer, skipping');
            return res.json({ success: false, message: 'User already has a referrer' });
        }
        
        // Update or create the referred user with referrer info
        if (existingUser) {
            // User exists but no referrer yet - update
            await supabase
                .from('users')
                .update({ referred_by: referrer_id })
                .eq('telegram_id', user_id);
            console.log('Updated existing user with referrer');
        } else {
            // New user - create with referrer
            await supabase.from('users').insert({
                telegram_id: user_id,
                username: username,
                photo_url: photo_url,
                referred_by: referrer_id,
                referral_count: 0
            });
            console.log('Created new user with referrer');
        }
        
        // Now increment the referrer's count
        // First check if referrer exists
        const { data: referrer } = await supabase
            .from('users')
            .select('telegram_id, referral_count')
            .eq('telegram_id', referrer_id)
            .single();
        
        if (referrer) {
            // Increment referral_count directly
            const newCount = (referrer.referral_count || 0) + 1;
            await supabase
                .from('users')
                .update({ referral_count: newCount })
                .eq('telegram_id', referrer_id);
            console.log('Incremented referrer count to', newCount);
        } else {
            // Create referrer user with count 1
            await supabase.from('users').insert({ 
                telegram_id: referrer_id,
                referral_count: 1
            });
            console.log('Created referrer with count 1');
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

// --- TELEGRAM BOT INLINE MODE ---
const TelegramBot = require('node-telegram-bot-api');

// Premium эмодзи ID
const EMOJI = {
    first: '<tg-emoji emoji-id="5440539497383087970">🥇</tg-emoji>',
    second: '<tg-emoji emoji-id="5447203607294265305">🥈</tg-emoji>',
    third: '<tg-emoji emoji-id="5453902265922376865">🥉</tg-emoji>',
    sparkle: '<tg-emoji emoji-id="5325547803936572038">✨</tg-emoji>',
    game: '<tg-emoji emoji-id="5361741454685256344">🎮</tg-emoji>',
    play: '<tg-emoji emoji-id="5427168083074628963">▶️</tg-emoji>',
    chart: '<tg-emoji emoji-id="5231200819986047254">📊</tg-emoji>',
    joystick: '<tg-emoji emoji-id="5438496463044752972">🕹</tg-emoji>',
    trophy: '<tg-emoji emoji-id="5280769763398671636">🏆</tg-emoji>',
    handshake: '<tg-emoji emoji-id="5357080225463149588">🤝</tg-emoji>',
};

// Обычные эмодзи для inline (Premium не поддерживается)
const EMOJI_INLINE = {
    first: '🥇',
    second: '🥈',
    third: '🥉',
    sparkle: '✨',
    game: '🎮',
    chart: '📊',
};

// --- TIC-TAC-TOE GAME ---
const tttGames = new Map(); // inline_message_id -> game state

const TTT_X = '❌';
const TTT_O = '⭕';
const TTT_EMPTY = '▫️';

function createTTTBoard() {
    return [
        [TTT_EMPTY, TTT_EMPTY, TTT_EMPTY],
        [TTT_EMPTY, TTT_EMPTY, TTT_EMPTY],
        [TTT_EMPTY, TTT_EMPTY, TTT_EMPTY]
    ];
}

function getTTTKeyboard(board, gameId) {
    return {
        inline_keyboard: board.map((row, r) => 
            row.map((cell, c) => ({
                text: cell,
                callback_data: `ttt_${gameId}_${r}_${c}`
            }))
        )
    };
}

function checkTTTWinner(board) {
    // Проверяем строки
    for (let i = 0; i < 3; i++) {
        if (board[i][0] !== TTT_EMPTY && board[i][0] === board[i][1] && board[i][1] === board[i][2]) {
            return board[i][0];
        }
    }
    // Проверяем столбцы
    for (let i = 0; i < 3; i++) {
        if (board[0][i] !== TTT_EMPTY && board[0][i] === board[1][i] && board[1][i] === board[2][i]) {
            return board[0][i];
        }
    }
    // Проверяем диагонали
    if (board[0][0] !== TTT_EMPTY && board[0][0] === board[1][1] && board[1][1] === board[2][2]) {
        return board[0][0];
    }
    if (board[0][2] !== TTT_EMPTY && board[0][2] === board[1][1] && board[1][1] === board[2][0]) {
        return board[0][2];
    }
    // Проверяем ничью
    let isDraw = true;
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
            if (board[r][c] === TTT_EMPTY) isDraw = false;
        }
    }
    if (isDraw) return 'draw';
    return null;
}

// --- CHECKERS GAME ---
const checkersGames = new Map(); // inline_message_id -> game state

const CH_WHITE = '⚪';
const CH_BLACK = '⚫';
const CH_EMPTY = '·';

function createCheckersBoard() {
    // 8x8 доска, шашки на тёмных клетках
    const board = [];
    for (let r = 0; r < 8; r++) {
        const row = [];
        for (let c = 0; c < 8; c++) {
            const isDark = (r + c) % 2 === 1;
            if (!isDark) {
                row.push({ type: 'light' }); // светлые клетки - нельзя ходить
            } else if (r < 3) {
                row.push({ type: 'piece', color: 'black', isKing: false });
            } else if (r > 4) {
                row.push({ type: 'piece', color: 'white', isKing: false });
            } else {
                row.push({ type: 'empty' }); // пустая тёмная клетка
            }
        }
        board.push(row);
    }
    return board;
}

function getCheckersKeyboard(board, gameId, selectedPos = null) {
    const keyboard = [];
    for (let r = 0; r < 8; r++) {
        const row = [];
        for (let c = 0; c < 8; c++) {
            const cell = board[r][c];
            let text;
            
            if (selectedPos && selectedPos.r === r && selectedPos.c === c) {
                text = '🟢';
            } else if (cell.type === 'light') {
                text = ' ';
            } else if (cell.type === 'empty') {
                text = CH_EMPTY;
            } else if (cell.type === 'piece') {
                if (cell.isKing) {
                    text = cell.color === 'white' ? '⬜' : '⬛';
                } else {
                    text = cell.color === 'white' ? CH_WHITE : CH_BLACK;
                }
            }
            
            row.push({
                text: text,
                callback_data: `ch_${gameId}_${r}_${c}`
            });
        }
        keyboard.push(row);
    }
    return { inline_keyboard: keyboard };
}

function getValidMoves(board, r, c, color) {
    const moves = [];
    const captures = [];
    const piece = board[r][c];
    if (piece.type !== 'piece' || piece.color !== color) return { moves: [], captures: [] };
    
    const allDirections = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    
    // Обычные ходы - только вперёд для обычных шашек, все направления для дамок
    const moveDirections = piece.isKing ? 
        allDirections : 
        (color === 'white' ? [[-1, -1], [-1, 1]] : [[1, -1], [1, 1]]);
    
    // Взятие - во все стороны для всех шашек!
    const captureDirections = allDirections;
    
    if (piece.isKing) {
        // Дамка - ходит на любое количество клеток по диагонали
        for (const [dr, dc] of moveDirections) {
            let nr = r + dr;
            let nc = c + dc;
            
            // Ищем пустые клетки или вражескую шашку
            while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
                const target = board[nr][nc];
                
                if (target.type === 'empty') {
                    moves.push({ r: nr, c: nc });
                } else if (target.type === 'piece' && target.color !== color) {
                    // Нашли вражескую шашку - проверяем можно ли перепрыгнуть
                    const jr = nr + dr;
                    const jc = nc + dc;
                    if (jr >= 0 && jr < 8 && jc >= 0 && jc < 8 && board[jr][jc].type === 'empty') {
                        // Можно бить, добавляем все пустые клетки за шашкой
                        let lr = jr;
                        let lc = jc;
                        while (lr >= 0 && lr < 8 && lc >= 0 && lc < 8 && board[lr][lc].type === 'empty') {
                            captures.push({ r: lr, c: lc, capturedR: nr, capturedC: nc });
                            lr += dr;
                            lc += dc;
                        }
                    }
                    break; // Дальше этой шашки не смотрим
                } else {
                    break; // Своя шашка или край доски
                }
                
                nr += dr;
                nc += dc;
            }
        }
    } else {
        // Обычная шашка - ходит на 1 клетку вперёд
        for (const [dr, dc] of moveDirections) {
            const nr = r + dr;
            const nc = c + dc;
            
            if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
                const target = board[nr][nc];
                if (target.type === 'empty') {
                    moves.push({ r: nr, c: nc });
                }
            }
        }
        
        // Взятие - во все 4 стороны
        for (const [dr, dc] of captureDirections) {
            const nr = r + dr;
            const nc = c + dc;
            
            if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
                const target = board[nr][nc];
                if (target.type === 'piece' && target.color !== color) {
                    const jr = nr + dr;
                    const jc = nc + dc;
                    if (jr >= 0 && jr < 8 && jc >= 0 && jc < 8 && board[jr][jc].type === 'empty') {
                        captures.push({ r: jr, c: jc, capturedR: nr, capturedC: nc });
                    }
                }
            }
        }
    }
    
    return { moves, captures };
}

function hasAnyCaptures(board, color) {
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const cell = board[r][c];
            if (cell.type === 'piece' && cell.color === color) {
                const { captures } = getValidMoves(board, r, c, color);
                if (captures.length > 0) return true;
            }
        }
    }
    return false;
}

function hasAnyMoves(board, color) {
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const cell = board[r][c];
            if (cell.type === 'piece' && cell.color === color) {
                const { moves, captures } = getValidMoves(board, r, c, color);
                if (moves.length > 0 || captures.length > 0) return true;
            }
        }
    }
    return false;
}

function countPieces(board, color) {
    let count = 0;
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            if (board[r][c].type === 'piece' && board[r][c].color === color) count++;
        }
    }
    return count;
}

// Функция для обновления статистики игр в шашки
async function incrementCheckersGames(oderId) {
    try {
        // Получаем текущее значение
        const { data } = await supabase
            .from('users')
            .select('checkers_total_pvp')
            .eq('telegram_id', oderId)
            .single();
        
        const current = data?.checkers_total_pvp || 0;
        
        // Обновляем
        await supabase
            .from('users')
            .update({ checkers_total_pvp: current + 1 })
            .eq('telegram_id', oderId);
            
        console.log(`Checkers games updated for user ${oderId}: ${current + 1}`);
    } catch (e) {
        console.error('Error updating checkers stats:', e.message);
    }
}

function getUserDisplayName(user) {
    if (user.username) return '@' + user.username;
    return user.first_name || 'Игрок';
}

// Конфигурация игр для inline режима
const GAME_CONFIG = {
    'block blast': { column: 'bb_best_score', name: 'Block Blast', isHigherBetter: true },
    'bb': { column: 'bb_best_score', name: 'Block Blast', isHigherBetter: true },
    'блок бласт': { column: 'bb_best_score', name: 'Block Blast', isHigherBetter: true },
    'blockblast': { column: 'bb_best_score', name: 'Block Blast', isHigherBetter: true },
    'сапер': { column: 'saper_wins', name: 'Сапёр', isHigherBetter: true },
    'saper': { column: 'saper_wins', name: 'Сапёр', isHigherBetter: true },
    'minesweeper': { column: 'saper_wins', name: 'Сапёр', isHigherBetter: true },
    'башня': { column: 'tower_best', name: 'Башня', isHigherBetter: true },
    'tower': { column: 'tower_best', name: 'Башня', isHigherBetter: true },
    'судоку': { column: 'sudoku_wins', name: 'Судоку', isHigherBetter: true },
    'sudoku': { column: 'sudoku_wins', name: 'Судоку', isHigherBetter: true },
    'шашки': { column: 'checkers_wins_pve', name: 'Шашки', isHigherBetter: true },
    'checkers': { column: 'checkers_wins_pve', name: 'Шашки', isHigherBetter: true },
    'вордли': { column: 'wordle_wins', name: 'Вордли', isHigherBetter: true },
    'wordle': { column: 'wordle_wins', name: 'Вордли', isHigherBetter: true },
    'рефералы': { column: 'referral_count', name: 'Рефералы', isHigherBetter: true },
    'referrals': { column: 'referral_count', name: 'Рефералы', isHigherBetter: true },
};

// Получить топ-3 + пользователя (с Premium эмодзи для бота)
async function getTopForGame(gameConfig, userId, usePremiumEmoji = true) {
    const { column, name, isHigherBetter } = gameConfig;
    const emojis = usePremiumEmoji ? EMOJI : EMOJI_INLINE;
    
    // Получаем топ-3
    const { data: top3 } = await supabase
        .from('users')
        .select(`telegram_id, username, ${column}`)
        .not(column, 'is', null)
        .gt(column, 0)
        .order(column, { ascending: !isHigherBetter })
        .limit(3);
    
    if (!top3 || top3.length === 0) {
        return { text: `<b>${name}</b>\n\nПока нет результатов`, userRank: null };
    }
    
    // Получаем все для определения места пользователя
    const { data: allUsers } = await supabase
        .from('users')
        .select(`telegram_id, username, ${column}`)
        .not(column, 'is', null)
        .gt(column, 0)
        .order(column, { ascending: !isHigherBetter });
    
    let userRank = null;
    let userData = null;
    
    if (userId && allUsers) {
        const userIndex = allUsers.findIndex(u => String(u.telegram_id) === String(userId));
        if (userIndex >= 0) {
            userRank = userIndex + 1;
            userData = allUsers[userIndex];
        }
    }
    
    // Формируем текст
    const medals = [emojis.first, emojis.second, emojis.third];
    let text = `<b>${name} — Топ игроков</b>\n\n`;
    
    top3.forEach((user, index) => {
        const medal = medals[index];
        const score = user[column];
        const username = user.username || 'Игрок';
        text += `${medal} ${username} — <b>${score}</b>\n`;
    });
    
    // Добавляем информацию о пользователе если он не в топ-3
    if (userRank && userRank > 3 && userData) {
        text += `\n━━━━━━━━━━━━━━━\n`;
        text += `📍 Вы: #${userRank} — <b>${userData[column]}</b>`;
    } else if (userRank && userRank <= 3) {
        text += `\n${emojis.sparkle} Вы в топ-${userRank}!`;
    }
    
    return { text, userRank };
}

// URL Mini App
const WEBAPP_URL = 'https://sevet-apps.github.io/glass-test-server/';

// Кэш для хранения данных inline запросов
const inlineCache = new Map();

// Инициализация бота
if (BOT_TOKEN) {
    const bot = new TelegramBot(BOT_TOKEN, { polling: true });
    
    // Обработчик ошибок polling - чтобы бот не падал
    bot.on('polling_error', (error) => {
        console.error('Polling error:', error.code, error.message);
    });
    
    bot.on('error', (error) => {
        console.error('Bot error:', error.message);
    });
    
    // Обработка inline запросов
    bot.on('inline_query', async (query) => {
        try {
        const queryText = query.query.toLowerCase().trim();
        const userId = query.from.id;
        const user = query.from;
        
        const results = [];
        
        // Если запрос пустой - показываем помощь
        if (!queryText) {
            const helpId = `help_${Date.now()}`;
            inlineCache.set(helpId, { type: 'help' });
            setTimeout(() => inlineCache.delete(helpId), 5 * 60 * 1000);
            
            results.push({
                type: 'article',
                id: helpId,
                title: '🎮 Spark Games',
                description: 'Топы игр, крестики-нолики и шашки',
                input_message_content: {
                    message_text: `🎮 <b>Spark Games</b>\n\n<b>Топы:</b>\n• Block Blast\n• Сапёр\n• Башня\n• Судоку\n• Шашки\n• Вордли\n\n<b>Игры:</b>\n• крестики-нолики\n• шашки\n\n📊 Напишите: @spark_beta_bot [команда]`,
                    parse_mode: 'HTML'
                },
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🎮 Играть', url: 'https://t.me/spark_beta_bot/SparkBETA' }
                    ]]
                }
            });
        } 
        // Крестики-нолики
        else if (queryText.includes('крестики') || queryText.includes('нолики') || queryText.includes('ttt') || queryText.includes('xo')) {
            const gameId = `ttt_${userId}_${Date.now()}`;
            const userName = getUserDisplayName(user);
            
            // Сохраняем данные создателя игры
            inlineCache.set(gameId, {
                type: 'ttt',
                creator: user,
                creatorName: userName
            });
            setTimeout(() => inlineCache.delete(gameId), 10 * 60 * 1000);
            
            results.push({
                type: 'article',
                id: gameId,
                title: '❌⭕ Крестики-нолики',
                description: 'Сыграйте с кем-то из чата!',
                input_message_content: {
                    message_text: `🕹 <b>${userName}</b> хочет сыграть в крестики-нолики!\n\nНажмите любую клетку, чтобы принять вызов.`,
                    parse_mode: 'HTML'
                },
                reply_markup: getTTTKeyboard(createTTTBoard(), gameId)
            });
        }
        // Шашки
        else if (queryText.includes('шашки') || queryText.includes('checkers')) {
            const gameId = `ch_${userId}_${Date.now()}`;
            const userName = getUserDisplayName(user);
            
            inlineCache.set(gameId, {
                type: 'checkers',
                creator: user,
                creatorName: userName
            });
            setTimeout(() => inlineCache.delete(gameId), 10 * 60 * 1000);
            
            results.push({
                type: 'article',
                id: gameId,
                title: '⚪⚫ Шашки',
                description: 'Сыграйте в шашки с кем-то из чата!',
                input_message_content: {
                    message_text: `🕹 <b>${userName}</b> хочет сыграть в шашки!\n\nНажмите на любую свою шашку, чтобы принять вызов.`,
                    parse_mode: 'HTML'
                },
                reply_markup: getCheckersKeyboard(createCheckersBoard(), gameId)
            });
        }
        else {
            // Ищем совпадение с игрой для топов
            let matchedGame = null;
            for (const [key, config] of Object.entries(GAME_CONFIG)) {
                if (queryText.includes(key)) {
                    matchedGame = config;
                    break;
                }
            }
            
            if (matchedGame) {
                try {
                    // Отправляем временное сообщение с обычными эмодзи
                    const { text } = await getTopForGame(matchedGame, userId, false);
                    
                    const resultId = `top_${matchedGame.column}_${Date.now()}`;
                    
                    // Сохраняем в кэш
                    inlineCache.set(resultId, { gameConfig: matchedGame, userId });
                    setTimeout(() => inlineCache.delete(resultId), 5 * 60 * 1000);
                    
                    results.push({
                        type: 'article',
                        id: resultId,
                        title: `Топ ${matchedGame.name}`,
                        description: 'Нажмите чтобы отправить топ в чат',
                        input_message_content: {
                            message_text: text,
                            parse_mode: 'HTML'
                        },
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🎮 Играть', url: 'https://t.me/spark_beta_bot/SparkBETA' }
                            ]]
                        }
                    });
                } catch (e) {
                    console.error('Inline query error:', e);
                }
            } else {
                // Предлагаем варианты
                const suggested = new Set();
                for (const [key, config] of Object.entries(GAME_CONFIG)) {
                    if ((key.includes(queryText) || config.name.toLowerCase().includes(queryText)) && !suggested.has(config.column)) {
                        suggested.add(config.column);
                        const resultId = `suggest_${config.column}_${Date.now()}`;
                        inlineCache.set(resultId, { gameConfig: config, userId });
                        setTimeout(() => inlineCache.delete(resultId), 5 * 60 * 1000);
                        
                        results.push({
                            type: 'article',
                            id: resultId,
                            title: `${config.name}`,
                            description: `Показать топ ${config.name}`,
                            input_message_content: {
                                message_text: `⏳ Загрузка...`,
                                parse_mode: 'HTML'
                            },
                            reply_markup: {
                                inline_keyboard: [[
                                    { text: '🎮 Играть', url: 'https://t.me/spark_beta_bot/SparkBETA' }
                                ]]
                            }
                        });
                    }
                }
            }
        }
        
        try {
            await bot.answerInlineQuery(query.id, results, { cache_time: 0 });
        } catch (e) {
            console.error('Answer inline query error:', e.message);
        }
        } catch (err) {
            console.error('Inline query handler error:', err.message);
        }
    });
    
    // Обработка chosen_inline_result
    bot.on('chosen_inline_result', async (result) => {
        try {
        const resultId = result.result_id;
        const inlineMessageId = result.inline_message_id;
        const userId = result.from.id;
        
        console.log('Chosen inline result:', resultId);
        
        if (!inlineMessageId) return;
        
        const cached = inlineCache.get(resultId);
        
        // Если это крестики-нолики - сохраняем игру
        if (cached?.type === 'ttt') {
            tttGames.set(inlineMessageId, {
                board: createTTTBoard(),
                playerX: cached.creator,
                playerO: null,
                playerXName: cached.creatorName,
                playerOName: null,
                currentTurn: 'X',
                gameId: resultId,
                status: 'waiting'
            });
            console.log('TTT game created:', inlineMessageId);
            setTimeout(() => tttGames.delete(inlineMessageId), 30 * 60 * 1000);
            
            try {
                await bot.editMessageText(
                    `${EMOJI.joystick} <b>${cached.creatorName}</b> хочет сыграть в крестики-нолики!\n\nНажмите любую клетку, чтобы принять вызов.`,
                    {
                        inline_message_id: inlineMessageId,
                        parse_mode: 'HTML',
                        reply_markup: getTTTKeyboard(createTTTBoard(), resultId)
                    }
                );
            } catch (e) {
                console.error('TTT edit error:', e.message);
            }
            return;
        }
        
        // Если это шашки - сохраняем игру
        if (cached?.type === 'checkers') {
            checkersGames.set(inlineMessageId, {
                board: createCheckersBoard(),
                playerWhite: cached.creator,
                playerBlack: null,
                playerWhiteName: cached.creatorName,
                playerBlackName: null,
                currentTurn: 'white',
                selected: null,
                gameId: resultId,
                status: 'waiting'
            });
            console.log('Checkers game created:', inlineMessageId);
            setTimeout(() => checkersGames.delete(inlineMessageId), 30 * 60 * 1000);
            
            try {
                await bot.editMessageText(
                    `${EMOJI.joystick} <b>${cached.creatorName}</b> хочет сыграть в шашки!\n\nНажмите на любую шашку, чтобы принять вызов.`,
                    {
                        inline_message_id: inlineMessageId,
                        parse_mode: 'HTML',
                        reply_markup: getCheckersKeyboard(createCheckersBoard(), resultId)
                    }
                );
            } catch (e) {
                console.error('Checkers edit error:', e.message);
            }
            return;
        }
        
        // Если это help - редактируем с Premium эмодзи
        if (cached?.type === 'help') {
            try {
                await bot.editMessageText(
                    `${EMOJI.game} <b>Spark Games</b>\n\n<b>Топы:</b>\n• Block Blast\n• Сапёр\n• Башня\n• Судоку\n• Шашки\n• Вордли\n\n<b>Игры:</b>\n• крестики-нолики\n• шашки\n\n${EMOJI.chart} Напишите: @spark_beta_bot [команда]`,
                    {
                        inline_message_id: inlineMessageId,
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🎮 Играть', url: 'https://t.me/spark_beta_bot/SparkBETA' }
                            ]]
                        }
                    }
                );
            } catch (e) {
                console.error('Help edit error:', e.message);
            }
            inlineCache.delete(resultId);
            return;
        }
        
        // Получаем данные из кэша для топов
        let gameConfig = cached?.gameConfig;
        
        if (!gameConfig) {
            for (const config of Object.values(GAME_CONFIG)) {
                if (resultId.includes(config.column)) {
                    gameConfig = config;
                    break;
                }
            }
        }
        
        if (gameConfig) {
            try {
                const { text } = await getTopForGame(gameConfig, userId, true);
                await bot.editMessageText(text, {
                    inline_message_id: inlineMessageId,
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '🎮 Играть', url: 'https://t.me/spark_beta_bot/SparkBETA' }
                        ]]
                    }
                });
                console.log('Message edited with premium emoji!');
            } catch (e) {
                console.error('Edit message error:', e.message);
            }
        }
        
        inlineCache.delete(resultId);
        } catch (err) {
            console.error('Chosen inline result error:', err.message);
        }
    });
    
    // Обработка нажатий на кнопки (для крестиков-ноликов)
    bot.on('callback_query', async (callbackQuery) => {
        try {
        const data = callbackQuery.data;
        const user = callbackQuery.from;
        const inlineMessageId = callbackQuery.inline_message_id;
        
        if (!inlineMessageId) {
            try { await bot.answerCallbackQuery(callbackQuery.id); } catch(e) {}
            return;
        }
        
        // === КРЕСТИКИ-НОЛИКИ ===
        if (data.startsWith('ttt_')) {
            const parts = data.split('_');
            const row = parseInt(parts[parts.length - 2]);
            const col = parseInt(parts[parts.length - 1]);
            
            const game = tttGames.get(inlineMessageId);
            
            if (!game) {
                try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Игра не найдена или истекла' }); } catch(e) {}
                return;
            }
            
            const userName = getUserDisplayName(user);
            
            // Если игра ждёт второго игрока
            if (game.status === 'waiting') {
                if (user.id === game.playerX.id) {
                    try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Ожидайте соперника!' }); } catch(e) {}
                    return;
                }
                
                // Второй игрок присоединяется
                game.playerO = user;
                game.playerOName = userName;
                game.status = 'playing';
                
                // Рандомно определяем кто ходит первым
                const firstIsX = Math.random() < 0.5;
                game.currentTurn = firstIsX ? 'X' : 'O';
                const firstPlayerName = firstIsX ? game.playerXName : game.playerOName;
                const firstSymbol = firstIsX ? '❌' : '⭕';
                
                try {
                    await bot.editMessageText(
                        `${EMOJI.joystick} <b>Крестики-нолики</b>\n\n${game.playerXName} (❌) vs ${game.playerOName} (⭕)\n\nПервый ход: ${firstPlayerName} (${firstSymbol})`,
                        {
                            inline_message_id: inlineMessageId,
                            parse_mode: 'HTML',
                            reply_markup: getTTTKeyboard(game.board, game.gameId)
                        }
                    );
                    await bot.answerCallbackQuery(callbackQuery.id, { text: `Игра началась! Ход ${firstPlayerName}` });
                } catch (e) {
                    console.error('Edit error:', e.message);
                    try { await bot.answerCallbackQuery(callbackQuery.id); } catch(e2) {}
                }
                return;
            }
            
            // Игра идёт
            if (game.status === 'playing') {
                const isPlayerX = user.id === game.playerX.id;
                const isPlayerO = user.id === game.playerO?.id;
                
                if (!isPlayerX && !isPlayerO) {
                    try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Вы не участвуете в этой игре!' }); } catch(e) {}
                    return;
                }
                
                const expectedSymbol = game.currentTurn;
                const isCorrectTurn = (expectedSymbol === 'X' && isPlayerX) || (expectedSymbol === 'O' && isPlayerO);
                
                if (!isCorrectTurn) {
                    try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Сейчас не ваш ход!' }); } catch(e) {}
                    return;
                }
                
                if (game.board[row][col] !== TTT_EMPTY) {
                    try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Клетка уже занята!' }); } catch(e) {}
                    return;
                }
                
                game.board[row][col] = expectedSymbol === 'X' ? TTT_X : TTT_O;
                
                const winner = checkTTTWinner(game.board);
                
                if (winner) {
                    game.status = 'finished';
                    let resultText;
                    
                    if (winner === 'draw') {
                        resultText = `${EMOJI.joystick} <b>Крестики-нолики</b>\n\n${game.playerXName} (❌) vs ${game.playerOName} (⭕)\n\n${EMOJI.handshake} <b>Ничья!</b>`;
                    } else {
                        const winnerName = winner === TTT_X ? game.playerXName : game.playerOName;
                        resultText = `${EMOJI.joystick} <b>Крестики-нолики</b>\n\n${game.playerXName} (❌) vs ${game.playerOName} (⭕)\n\n${EMOJI.trophy} <b>${winnerName}</b> победил! ${winner}`;
                    }
                    
                    try {
                        await bot.editMessageText(resultText, {
                            inline_message_id: inlineMessageId,
                            parse_mode: 'HTML',
                            reply_markup: getTTTKeyboard(game.board, game.gameId)
                        });
                        await bot.answerCallbackQuery(callbackQuery.id, { text: winner === 'draw' ? 'Ничья!' : 'Победа!' });
                    } catch (e) {
                        console.error('Edit error:', e.message);
                    }
                    
                    tttGames.delete(inlineMessageId);
                    return;
                }
                
                game.currentTurn = game.currentTurn === 'X' ? 'O' : 'X';
                const nextPlayerName = game.currentTurn === 'X' ? game.playerXName : game.playerOName;
                const nextSymbol = game.currentTurn === 'X' ? '❌' : '⭕';
                
                try {
                    await bot.editMessageText(
                        `${EMOJI.joystick} <b>Крестики-нолики</b>\n\n${game.playerXName} (❌) vs ${game.playerOName} (⭕)\n\nХод: ${nextPlayerName} (${nextSymbol})`,
                        {
                            inline_message_id: inlineMessageId,
                            parse_mode: 'HTML',
                            reply_markup: getTTTKeyboard(game.board, game.gameId)
                        }
                    );
                    await bot.answerCallbackQuery(callbackQuery.id);
                } catch (e) {
                    console.error('Edit error:', e.message);
                }
                return;
            }
            
            if (game.status === 'finished') {
                try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Игра уже завершена!' }); } catch(e) {}
                return;
            }
        }
        
        // === ШАШКИ ===
        else if (data.startsWith('ch_')) {
            const parts = data.split('_');
            const row = parseInt(parts[parts.length - 2]);
            const col = parseInt(parts[parts.length - 1]);
            
            const game = checkersGames.get(inlineMessageId);
            
            if (!game) {
                try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Игра не найдена или истекла' }); } catch(e) {}
                return;
            }
            
            const userName = getUserDisplayName(user);
            
            // Ожидание второго игрока
            if (game.status === 'waiting') {
                if (user.id === game.playerWhite.id) {
                    try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Ожидайте соперника!' }); } catch(e) {}
                    return;
                }
                
                game.playerBlack = user;
                game.playerBlackName = userName;
                game.status = 'playing';
                
                // Рандомно определяем кто ходит первым
                const whiteFirst = Math.random() < 0.5;
                game.currentTurn = whiteFirst ? 'white' : 'black';
                const firstPlayerName = whiteFirst ? game.playerWhiteName : game.playerBlackName;
                const firstSymbol = whiteFirst ? '⚪' : '⚫';
                
                try {
                    await bot.editMessageText(
                        `${EMOJI.joystick} <b>Шашки</b>\n\n${game.playerWhiteName} (⚪) vs ${game.playerBlackName} (⚫)\n\nПервый ход: ${firstPlayerName} (${firstSymbol})`,
                        {
                            inline_message_id: inlineMessageId,
                            parse_mode: 'HTML',
                            reply_markup: getCheckersKeyboard(game.board, game.gameId)
                        }
                    );
                    await bot.answerCallbackQuery(callbackQuery.id, { text: `Игра началась! Ход ${firstPlayerName}` });
                } catch (e) {
                    console.error('Edit error:', e.message);
                }
                return;
            }
            
            // Игра идёт
            if (game.status === 'playing') {
                const isWhite = user.id === game.playerWhite.id;
                const isBlack = user.id === game.playerBlack?.id;
                
                if (!isWhite && !isBlack) {
                    try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Вы не участвуете в этой игре!' }); } catch(e) {}
                    return;
                }
                
                const playerColor = isWhite ? 'white' : 'black';
                
                if (game.currentTurn !== playerColor) {
                    try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Сейчас не ваш ход!' }); } catch(e) {}
                    return;
                }
                
                const cell = game.board[row][col];
                
                // Если есть выбранная шашка
                if (game.selected) {
                    const { moves, captures } = getValidMoves(game.board, game.selected.r, game.selected.c, playerColor);
                    const mustCapture = hasAnyCaptures(game.board, playerColor);
                    
                    // Клик на свою шашку - меняем выбор
                    if (cell.type === 'piece' && cell.color === playerColor) {
                        game.selected = { r: row, c: col };
                        try {
                            await bot.editMessageReplyMarkup(getCheckersKeyboard(game.board, game.gameId, game.selected), {
                                inline_message_id: inlineMessageId
                            });
                            await bot.answerCallbackQuery(callbackQuery.id);
                        } catch (e) {}
                        return;
                    }
                    
                    // Проверяем ход
                    const capture = captures.find(c => c.r === row && c.c === col);
                    const move = moves.find(m => m.r === row && m.c === col);
                    
                    if (mustCapture && !capture) {
                        try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Нужно бить!' }); } catch(e) {}
                        return;
                    }
                    
                    if (capture) {
                        // Выполняем взятие
                        const piece = game.board[game.selected.r][game.selected.c];
                        game.board[row][col] = piece;
                        game.board[game.selected.r][game.selected.c] = { type: 'empty' };
                        game.board[capture.capturedR][capture.capturedC] = { type: 'empty' };
                        
                        // Проверяем превращение в дамку
                        if ((playerColor === 'white' && row === 0) || (playerColor === 'black' && row === 7)) {
                            game.board[row][col].isKing = true;
                        }
                        
                        // Проверяем можно ли бить ещё
                        const { captures: moreCaps } = getValidMoves(game.board, row, col, playerColor);
                        if (moreCaps.length > 0) {
                            game.selected = { r: row, c: col };
                            try {
                                await bot.editMessageReplyMarkup(getCheckersKeyboard(game.board, game.gameId, game.selected), {
                                    inline_message_id: inlineMessageId
                                });
                                await bot.answerCallbackQuery(callbackQuery.id, { text: 'Бей ещё!' });
                            } catch (e) {}
                            return;
                        }
                    } else if (move && !mustCapture) {
                        // Обычный ход
                        const piece = game.board[game.selected.r][game.selected.c];
                        game.board[row][col] = piece;
                        game.board[game.selected.r][game.selected.c] = { type: 'empty' };
                        
                        // Проверяем превращение в дамку
                        if ((playerColor === 'white' && row === 0) || (playerColor === 'black' && row === 7)) {
                            game.board[row][col].isKing = true;
                        }
                    } else {
                        try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Нельзя туда ходить!' }); } catch(e) {}
                        return;
                    }
                    
                    game.selected = null;
                    
                    // Меняем ход
                    const opponentColor = playerColor === 'white' ? 'black' : 'white';
                    
                    // Проверяем победу
                    const opponentPieces = countPieces(game.board, opponentColor);
                    const opponentCanMove = hasAnyMoves(game.board, opponentColor);
                    
                    if (opponentPieces === 0 || !opponentCanMove) {
                        game.status = 'finished';
                        const winnerName = playerColor === 'white' ? game.playerWhiteName : game.playerBlackName;
                        const winnerSymbol = playerColor === 'white' ? '⚪' : '⚫';
                        
                        // Обновляем статистику обоих игроков
                        await incrementCheckersGames(game.playerWhite.id);
                        await incrementCheckersGames(game.playerBlack.id);
                        
                        try {
                            await bot.editMessageText(
                                `${EMOJI.joystick} <b>Шашки</b>\n\n${game.playerWhiteName} (⚪) vs ${game.playerBlackName} (⚫)\n\n${EMOJI.trophy} <b>${winnerName}</b> победил! ${winnerSymbol}`,
                                {
                                    inline_message_id: inlineMessageId,
                                    parse_mode: 'HTML',
                                    reply_markup: getCheckersKeyboard(game.board, game.gameId)
                                }
                            );
                            await bot.answerCallbackQuery(callbackQuery.id, { text: 'Победа!' });
                        } catch (e) {}
                        
                        checkersGames.delete(inlineMessageId);
                        return;
                    }
                    
                    game.currentTurn = opponentColor;
                    const nextName = opponentColor === 'white' ? game.playerWhiteName : game.playerBlackName;
                    const nextSymbol = opponentColor === 'white' ? '⚪' : '⚫';
                    
                    try {
                        await bot.editMessageText(
                            `${EMOJI.joystick} <b>Шашки</b>\n\n${game.playerWhiteName} (⚪) vs ${game.playerBlackName} (⚫)\n\nХод: ${nextName} (${nextSymbol})`,
                            {
                                inline_message_id: inlineMessageId,
                                parse_mode: 'HTML',
                                reply_markup: getCheckersKeyboard(game.board, game.gameId)
                            }
                        );
                        await bot.answerCallbackQuery(callbackQuery.id);
                    } catch (e) {}
                    return;
                } else {
                    // Выбираем шашку
                    if (cell.type === 'piece' && cell.color === playerColor) {
                        const { moves, captures } = getValidMoves(game.board, row, col, playerColor);
                        if (moves.length === 0 && captures.length === 0) {
                            try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Эта шашка не может ходить!' }); } catch(e) {}
                            return;
                        }
                        
                        // Проверяем обязательное взятие
                        const mustCapture = hasAnyCaptures(game.board, playerColor);
                        if (mustCapture && captures.length === 0) {
                            try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Выберите шашку которая может бить!' }); } catch(e) {}
                            return;
                        }
                        
                        game.selected = { r: row, c: col };
                        try {
                            await bot.editMessageReplyMarkup(getCheckersKeyboard(game.board, game.gameId, game.selected), {
                                inline_message_id: inlineMessageId
                            });
                            await bot.answerCallbackQuery(callbackQuery.id, { text: 'Выберите куда ходить' });
                        } catch (e) {}
                    } else {
                        try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Выберите свою шашку!' }); } catch(e) {}
                    }
                    return;
                }
            }
            
            if (game.status === 'finished') {
                try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Игра уже завершена!' }); } catch(e) {}
                return;
            }
        }
        
        try { await bot.answerCallbackQuery(callbackQuery.id); } catch(e) {}
        } catch (err) {
            console.error('Callback query error:', err.message);
            try { await bot.answerCallbackQuery(callbackQuery.id); } catch(e) {}
        }
    });
    
    // Команда /start
    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        bot.sendMessage(chatId, 
            `${EMOJI.game} <b>Добро пожаловать в Spark Games!</b>\n\n` +
            `Играйте в крутые игры и соревнуйтесь с друзьями!\n\n` +
            `${EMOJI.play} <b>Открыть игры:</b> нажмите кнопку ниже\n` +
            `${EMOJI.chart} <b>Топы:</b> @spark_beta_bot [игра]\n` +
            `${EMOJI.joystick} <b>Игры в чате:</b>\n` +
            `• @spark_beta_bot крестики\n` +
            `• @spark_beta_bot шашки`,
            { 
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🎮 Играть', web_app: { url: WEBAPP_URL } }
                    ]]
                }
            }
        );
    });
    
    // Команда /top [игра] - с Premium эмодзи!
    bot.onText(/\/top(.*)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const gameName = match[1].trim().toLowerCase();
        
        if (!gameName) {
            bot.sendMessage(chatId,
                `${EMOJI.chart} <b>Доступные топы:</b>\n\n` +
                `• /top block blast\n` +
                `• /top сапер\n` +
                `• /top башня\n` +
                `• /top судоку\n` +
                `• /top шашки\n` +
                `• /top вордли\n` +
                `• /top рефералы`,
                { parse_mode: 'HTML' }
            );
            return;
        }
        
        let matchedGame = null;
        for (const [key, config] of Object.entries(GAME_CONFIG)) {
            if (gameName.includes(key) || key.includes(gameName)) {
                matchedGame = config;
                break;
            }
        }
        
        if (matchedGame) {
            try {
                const { text } = await getTopForGame(matchedGame, userId, true);
                bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
            } catch (e) {
                console.error('Top command error:', e);
                bot.sendMessage(chatId, 'Ошибка загрузки топа');
            }
        } else {
            bot.sendMessage(chatId, 'Игра не найдена. Напишите /top для списка.', { parse_mode: 'HTML' });
        }
    });
    
    console.log('Telegram Bot initialized with inline + premium emoji support');
} else {
    console.log('BOT_TOKEN not set, Telegram Bot disabled');
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Glass API v37.0 running on port ${PORT}`));