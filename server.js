// server.js

const express = require('express');
const app = express();
const server = require('http').Server(app);
const io = require('socket.io')(server);

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

app.use(express.static(__dirname + '/'));

let lobbies = {}; // Key: lobbyCode, Value: lobby data

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    socket.on('createLobby', () => {
        let lobbyCode = generateLobbyCode();
        lobbies[lobbyCode] = {
            players: {},
            enemies: [],
            bullets: [],
            enemyBullets: [],
            wave: 1,
            maxWaves: 20,
            gameInterval: null,
            isGameRunning: false,
            host: socket.id,
            enemiesToSpawn: 0,
            spawnInterval: 2000, // Time between enemy spawns (in milliseconds)
            lastSpawnTime: Date.now(),
            inputs: {}, // Store inputs from clients
        };
        socket.join(lobbyCode);
        lobbies[lobbyCode].players[socket.id] = createNewPlayer(socket.id);
        socket.emit('lobbyCreated', lobbyCode);
        updateLobbyData(lobbyCode);
    });

    socket.on('joinLobby', (lobbyCode) => {
        if (lobbies[lobbyCode]) {
            if (Object.keys(lobbies[lobbyCode].players).length < 4) {
                socket.join(lobbyCode);
                lobbies[lobbyCode].players[socket.id] = createNewPlayer(socket.id);
                socket.emit('lobbyJoined', lobbyCode);
                updateLobbyData(lobbyCode);
            } else {
                socket.emit('error', 'Lobby is full.');
            }
        } else {
            socket.emit('error', 'Lobby does not exist.');
        }
    });

    socket.on('playerMovement', (data) => {
        let lobbyCode = data.lobbyCode;
        let input = data.input;
        let lobby = lobbies[lobbyCode];
        if (lobby && lobby.players[socket.id] && !lobby.players[socket.id].dead) {
            if (!lobby.inputs[socket.id]) {
                lobby.inputs[socket.id] = [];
            }
            lobby.inputs[socket.id].push(input);
        }
    });

    socket.on('shoot', (data) => {
        let lobbyCode = data.lobbyCode;
        let direction = data.direction;
        let lobby = lobbies[lobbyCode];
        if (lobby && lobby.players[socket.id] && !lobby.players[socket.id].dead) {
            let player = lobby.players[socket.id];
            let dirX = direction.x;
            let dirY = direction.y;
            if (dirX !== 0 || dirY !== 0) {
                // Normalize direction vector
                let length = Math.hypot(dirX, dirY);
                let normalizedDir = { x: dirX / length, y: dirY / length };

                lobby.bullets.push({
                    x: player.x + 10,
                    y: player.y + 10,
                    dx: normalizedDir.x * 10,
                    dy: normalizedDir.y * 10,
                    owner: socket.id,
                });
            }
        }
    });

    socket.on('startGame', (lobbyCode) => {
        let lobby = lobbies[lobbyCode];
        if (lobby && socket.id === lobby.host && !lobby.isGameRunning) {
            startGame(lobbyCode);
        }
    });

    // Updated latency measurement
    socket.on('ping', () => {
        socket.emit('latency');
    });

    socket.on('exitLobby', (lobbyCode) => {
        leaveLobby(socket, lobbyCode);
    });

    socket.on('leaveGame', (lobbyCode) => {
        leaveLobby(socket, lobbyCode);
    });

    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        for (let lobbyCode in lobbies) {
            if (lobbies[lobbyCode].players[socket.id]) {
                leaveLobby(socket, lobbyCode);
            }
        }
    });
});

function createNewPlayer(id) {
    return {
        x: 400, // Center of the canvas (800 / 2)
        y: 300, // Center of the canvas (600 / 2)
        hp: 100,
        index: 1,
        direction: { x: 0, y: -1 },
        dead: false,
        lastProcessedInput: 0,
    };
}

function updateLobbyData(lobbyCode) {
    let lobby = lobbies[lobbyCode];
    let playersList = Object.values(lobby.players).map((player, index) => {
        player.index = index + 1;
        return { index: player.index };
    });
    io.to(lobbyCode).emit('lobbyData', { players: playersList });
}

function leaveLobby(socket, lobbyCode) {
    let lobby = lobbies[lobbyCode];
    if (lobby) {
        delete lobby.players[socket.id];
        socket.leave(lobbyCode);
        // If host leaves, assign new host or delete lobby
        if (lobby.host === socket.id) {
            let playerIds = Object.keys(lobby.players);
            if (playerIds.length > 0) {
                lobby.host = playerIds[0];
            } else {
                // Stop game interval if running
                if (lobby.gameInterval) clearInterval(lobby.gameInterval);
                delete lobbies[lobbyCode];
                return;
            }
        }
        updateLobbyData(lobbyCode);
    }
}

// Define enemy types based on color
const EnemyTypes = {
    'red': {
        behavior: 'standard',
        speedMultiplier: 1,
        hpMultiplier: 1,
        damage: 1,
    },
    'green': {
        behavior: 'fast',
        speedMultiplier: 1.5,
        hpMultiplier: 0.5,
        damage: 0.5,
    },
    'purple': {
        behavior: 'tank',
        speedMultiplier: 0.7,
        hpMultiplier: 2,
        damage: 2,
    },
    'orange': {
        behavior: 'ranged',
        speedMultiplier: 1,
        hpMultiplier: 1,
        damage: 1,
        shootCooldown: 2000, // Cooldown time between shots in milliseconds
    },
};

function startGame(lobbyCode) {
    let lobby = lobbies[lobbyCode];
    if (lobby) {
        lobby.isGameRunning = true;
        lobby.wave = 1;
        resetPlayerPositions(lobby); // Reset player positions at the start
        setupWave(lobbyCode);
        lobby.gameInterval = setInterval(() => gameLoop(lobbyCode), 1000 / 60);
        io.to(lobbyCode).emit('startGame');
    }
}

function setupWave(lobbyCode) {
    let lobby = lobbies[lobbyCode];
    lobby.enemies = [];
    lobby.enemyBullets = [];
    lobby.enemiesToSpawn = lobby.wave * 10; // Increase number of enemies per wave
    lobby.lastSpawnTime = Date.now();
    resetPlayerPositions(lobby); // Reset player positions at the start of each wave
}

function resetPlayerPositions(lobby) {
    for (let id in lobby.players) {
        lobby.players[id].x = 400; // Center of the canvas
        lobby.players[id].y = 300;
        lobby.players[id].dead = false;
        lobby.players[id].hp = 100;
        lobby.players[id].lastProcessedInput = 0;
        lobby.inputs[id] = [];
    }
}

function gameLoop(lobbyCode) {
    let lobby = lobbies[lobbyCode];
    if (!lobby) return;

    // Process player inputs
    for (let id in lobby.players) {
        let player = lobby.players[id];
        let inputs = lobby.inputs[id] || [];
        for (let input of inputs) {
            applyInput(player, input);
            player.lastProcessedInput = input.seq;
        }
        lobby.inputs[id] = []; // Clear processed inputs
    }

    // Spawn enemies over time
    spawnEnemiesOverTime(lobby);

    updateBullets(lobbyCode);
    updateEnemies(lobbyCode);
    updateEnemyBullets(lobbyCode);
    checkGameOver(lobbyCode);

    io.to(lobbyCode).emit('updateState', {
        players: lobby.players,
        enemies: lobby.enemies,
        bullets: lobby.bullets,
        enemyBullets: lobby.enemyBullets || [],
        wave: lobby.wave,
        lastProcessedInput: getLastProcessedInput(lobby, lobby.players),
    });
}

function getLastProcessedInput(lobby, players) {
    let minSeq = Infinity;
    for (let id in players) {
        minSeq = Math.min(minSeq, players[id].lastProcessedInput);
    }
    return minSeq;
}

function applyInput(player, input) {
    let movement = input.movement;
    let speed = 5;
    let moveX = 0;
    let moveY = 0;
    if (movement.up) moveY -= 1;
    if (movement.down) moveY += 1;
    if (movement.left) moveX -= 1;
    if (movement.right) moveX += 1;

    // Normalize movement vector
    let length = Math.hypot(moveX, moveY);
    if (length > 0) {
        moveX = (moveX / length) * speed;
        moveY = (moveY / length) * speed;
        player.x += moveX;
        player.y += moveY;
    }

    // Ensure player stays within the game boundaries
    player.x = Math.max(0, Math.min(player.x, 780)); // Assuming player width is 20
    player.y = Math.max(0, Math.min(player.y, 580)); // Assuming player height is 20
}

function spawnEnemiesOverTime(lobby) {
    let currentTime = Date.now();
    let groupSize = 3; // Number of enemies to spawn at each interval
    if (lobby.enemiesToSpawn > 0 && currentTime - lobby.lastSpawnTime >= lobby.spawnInterval) {
        lobby.lastSpawnTime = currentTime;
        let enemiesToSpawnNow = Math.min(groupSize, lobby.enemiesToSpawn);
        for (let i = 0; i < enemiesToSpawnNow; i++) {
            spawnSingleEnemy(lobby);
            lobby.enemiesToSpawn--;
        }
    }
}

function spawnSingleEnemy(lobby) {
    let colors = ['red', 'green', 'purple', 'orange'];
    let color = colors[Math.floor(Math.random() * colors.length)];
    let enemyType = EnemyTypes[color];

    // Spawn enemies outside the game area
    let side = Math.floor(Math.random() * 4); // 0: top, 1: bottom, 2: left, 3: right
    let x, y;

    switch (side) {
        case 0: // Top
            x = Math.random() * 800;
            y = -20; // Just above the canvas
            break;
        case 1: // Bottom
            x = Math.random() * 800;
            y = 600 + 20; // Just below the canvas
            break;
        case 2: // Left
            x = -20; // Just left of the canvas
            y = Math.random() * 600;
            break;
        case 3: // Right
            x = 800 + 20; // Just right of the canvas
            y = Math.random() * 600;
            break;
    }

    lobby.enemies.push({
        x: x,
        y: y,
        color: color,
        behavior: enemyType.behavior,
        hp: (50 + lobby.wave * 10) * enemyType.hpMultiplier,
        speed: (1 + lobby.wave * 0.1) * enemyType.speedMultiplier,
        damage: enemyType.damage,
        shootCooldown: enemyType.shootCooldown || 0,
        lastShotTime: 0, // For ranged enemies
    });
}

function updateBullets(lobbyCode) {
    let lobby = lobbies[lobbyCode];
    // Move bullets
    lobby.bullets.forEach((bullet) => {
        bullet.x += bullet.dx;
        bullet.y += bullet.dy;
    });

    // Check collision with enemies
    lobby.bullets.forEach((bullet) => {
        lobby.enemies.forEach((enemy) => {
            let dx = bullet.x - enemy.x;
            let dy = bullet.y - enemy.y;
            let dist = Math.hypot(dx, dy);
            let collisionRadius = enemy.behavior === 'tank' ? 25 : 15;
            if (dist < collisionRadius) {
                enemy.hp -= 20;
                bullet.hit = true;
            }
        });
    });

    // Remove bullets that hit or go off-screen
    lobby.bullets = lobby.bullets.filter(bullet =>
        !bullet.hit &&
        bullet.x >= -50 && bullet.x <= 850 &&
        bullet.y >= -50 && bullet.y <= 650
    );

    // Remove dead enemies
    lobby.enemies = lobby.enemies.filter(e => e.hp > 0);

    // Proceed to next wave
    if (lobby.enemies.length === 0 && lobby.enemiesToSpawn === 0 && lobby.wave < lobby.maxWaves) {
        lobby.wave++;
        setupWave(lobbyCode);
    } else if (lobby.enemies.length === 0 && lobby.enemiesToSpawn === 0 && lobby.wave >= lobby.maxWaves) {
        endGame(lobbyCode, 'victory');
    }
}

function updateEnemies(lobbyCode) {
    let lobby = lobbies[lobbyCode];
    let currentTime = Date.now();

    lobby.enemies.forEach((enemy) => {
        // Find the nearest alive player
        let nearestPlayer = null;
        let minDist = Infinity;
        for (let id in lobby.players) {
            let player = lobby.players[id];
            if (!player.dead) {
                let dx = player.x - enemy.x;
                let dy = player.y - enemy.y;
                let dist = Math.hypot(dx, dy);
                if (dist < minDist) {
                    minDist = dist;
                    nearestPlayer = player;
                }
            }
        }

        if (nearestPlayer) {
            let dx = nearestPlayer.x - enemy.x;
            let dy = nearestPlayer.y - enemy.y;
            let dist = Math.hypot(dx, dy);

            // Behavior based on enemy type
            switch (enemy.behavior) {
                case 'standard':
                case 'fast':
                case 'tank':
                    // Move towards the player
                    enemy.x += (dx / dist) * enemy.speed;
                    enemy.y += (dy / dist) * enemy.speed;

                    // Check collision with player
                    let collisionRadius = 20;
                    if (dist < collisionRadius) {
                        nearestPlayer.hp -= enemy.damage;
                        if (nearestPlayer.hp <= 0) {
                            nearestPlayer.dead = true;
                        }
                    }
                    break;

                case 'ranged':
                    // Ranged enemies stay at a distance and shoot
                    if (dist > 150) {
                        // Move closer to shooting range
                        enemy.x += (dx / dist) * enemy.speed;
                        enemy.y += (dy / dist) * enemy.speed;
                    } else if (dist < 100) {
                        // Move away if too close
                        enemy.x -= (dx / dist) * enemy.speed;
                        enemy.y -= (dy / dist) * enemy.speed;
                    }

                    // Shoot at the player if cooldown has passed
                    if (currentTime - enemy.lastShotTime > enemy.shootCooldown) {
                        shootAtPlayer(lobby, enemy, nearestPlayer);
                        enemy.lastShotTime = currentTime;
                    }
                    break;
            }
        }
    });
}

function shootAtPlayer(lobby, enemy, player) {
    let dx = player.x - enemy.x;
    let dy = player.y - enemy.y;
    let dist = Math.hypot(dx, dy);

    let bulletSpeed = 5;
    let bulletDx = (dx / dist) * bulletSpeed;
    let bulletDy = (dy / dist) * bulletSpeed;

    // Add the enemy bullet to the array
    lobby.enemyBullets.push({
        x: enemy.x,
        y: enemy.y,
        dx: bulletDx,
        dy: bulletDy,
        damage: enemy.damage,
    });
}

function updateEnemyBullets(lobbyCode) {
    let lobby = lobbies[lobbyCode];
    if (!lobby.enemyBullets) return;

    lobby.enemyBullets.forEach((bullet) => {
        bullet.x += bullet.dx;
        bullet.y += bullet.dy;

        // Check collision with players
        for (let id in lobby.players) {
            let player = lobby.players[id];
            if (!player.dead) {
                let dx = bullet.x - player.x;
                let dy = bullet.y - player.y;
                let dist = Math.hypot(dx, dy);
                if (dist < 10) {
                    player.hp -= bullet.damage * 10; // Adjust damage as needed
                    bullet.hit = true;
                    if (player.hp <= 0) {
                        player.dead = true;
                    }
                }
            }
        }
    });

    // Remove bullets that hit or go off-screen
    lobby.enemyBullets = lobby.enemyBullets.filter(bullet =>
        !bullet.hit &&
        bullet.x >= -50 && bullet.x <= 850 &&
        bullet.y >= -50 && bullet.y <= 650
    );
}

function checkGameOver(lobbyCode) {
    let lobby = lobbies[lobbyCode];
    let allDead = true;
    for (let id in lobby.players) {
        if (!lobby.players[id].dead) {
            allDead = false;
            break;
        }
    }
    if (allDead) {
        endGame(lobbyCode, 'gameOver');
    }
}

function endGame(lobbyCode, result) {
    let lobby = lobbies[lobbyCode];
    clearInterval(lobby.gameInterval);
    lobby.isGameRunning = false;
    if (result === 'victory') {
        io.to(lobbyCode).emit('victory');
    } else {
        io.to(lobbyCode).emit('gameOver');
    }
    resetGame(lobbyCode);
}

function resetGame(lobbyCode) {
    let lobby = lobbies[lobbyCode];
    for (let id in lobby.players) {
        lobby.players[id].hp = 100;
        lobby.players[id].x = 400; // Center of the canvas
        lobby.players[id].y = 300;
        lobby.players[id].dead = false;
        lobby.players[id].lastProcessedInput = 0;
    }
    lobby.enemies = [];
    lobby.bullets = [];
    lobby.enemyBullets = [];
    lobby.wave = 1;
    lobby.enemiesToSpawn = 0;
    lobby.lastSpawnTime = Date.now();
    lobby.inputs = {};
}

function generateLobbyCode() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}
