// UserService.js — Sample service with some bugs and patterns
const { User, UserDTO } = require('../models/User');
const { DatabaseError } = require('../errors');
const cacheService = require('./CacheService');
const logger = require('../utils/logger');

class UserService {
  constructor(userRepo, emailService) {
    this.userRepo = userRepo;
    this.emailService = emailService;
  }

  /**
   * Get user by ID — cached
   */
  async getUserById(id) {
    const cacheKey = `user:${id}`;
    
    const cached = await cacheService.get(cacheKey);
    if (cached) return cached;

    const user = await this.userRepo.findById(id);
    if (!user) return null;

    const dto = new UserDTO(user); // BUG: UserDTO expects a plain object, not a Mongoose doc
    await cacheService.set(cacheKey, dto, 300);

    return dto;
  }

  /**
   * Create a new user
   */
  async createUser(data) {
    const existing = await this.userRepo.findByEmail(data.email);
    if (existing) {
      throw new Error('User with this email already exists');
    }

    const user = await this.userRepo.create({
      ...data,
      createdAt: new Date(),
      status: 'pending',
    });

    // Send welcome email (async, don't await)
    this.emailService.sendWelcome(user.email).catch(err => {
      logger.error(`Failed to send welcome email: ${err.message}`);
    });

    return new UserDTO(user);
  }

  /**
   * Update user status
   * NOTE: This triggers webhooks and cache invalidation
   */
  async updateStatus(userId, newStatus) {
    const validStatuses = ['active', 'inactive', 'banned', 'pending'];
    if (!validStatuses.includes(newStatus)) {
      throw new Error(`Invalid status: ${newStatus}`);
    }

    const user = await this.userRepo.findById(userId);
    if (!user) throw new DatabaseError(`User not found: ${userId}`);

    const old = user.status;
    user.status = newStatus;
    await this.userRepo.save(user);

    // Invalidate cache
    await cacheService.delete(`user:${userId}`);

    // Emit status change event
    this._emit('user.status.changed', { userId, old, new: newStatus });

    return { success: true, old, new: newStatus };
  }

  _emit(event, data) {
    // TODO: replace with proper event bus
    process.emit(event, data);
  }
}

module.exports = UserService;
