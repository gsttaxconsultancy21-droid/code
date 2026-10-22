// Tunables shared by the simulation and the bots.
export const STEP = 1 / 60; // fixed simulation step (seconds); replays depend on it
export const PLAYER_SPEED = 6.5; // cells per second
export const TURN_RATE = 10; // radians per second
export const START_RADIUS = 3;
export const BOT_RESPAWN = 2.5; // seconds
export const DEATH_LINGER = 1.25; // seconds before the human's game ends

export const POWERUP_TYPES = ['speed', 'shield', 'bomb'];
export const POWERUPS = {
  speed: { duration: 4, factor: 1.6 },
  shield: { duration: 6 },
  bomb: { radius: 4 },
};
