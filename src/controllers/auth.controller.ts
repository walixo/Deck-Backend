import type { Request, Response } from 'express';
import { User } from '../models/User';
import { toAuthenticatedUser } from '../serializers';
import { ApiError } from '../utils/ApiError';
import { signToken } from '../utils/jwt';
import type { LoginInput, RegisterInput, UpdateProfileInput } from '../validators/auth.validators';

export async function register(req: Request, res: Response): Promise<void> {
  const { name, username, email, password } = req.body as RegisterInput;

  const existing = await User.findOne({ $or: [{ email }, { username }] });
  if (existing) {
    throw ApiError.conflict(
      existing.email === email
        ? 'An account with that email already exists'
        : 'That username is already taken',
    );
  }

  // No avatar by default — the client renders a deterministic initials avatar instead.
  const user = await User.create({ name, username, email, password });

  const token = signToken({ sub: user._id.toString(), username: user.username });

  res.status(201).json({
    success: true,
    data: { token, user: toAuthenticatedUser(user) },
  });
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as LoginInput;

  const user = await User.findOne({ email }).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    throw ApiError.unauthorized('That email and password combination did not work');
  }

  const token = signToken({ sub: user._id.toString(), username: user.username });

  res.json({ success: true, data: { token, user: toAuthenticatedUser(user) } });
}

export async function me(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: toAuthenticatedUser(req.user!) });
}

export async function updateProfile(req: Request, res: Response): Promise<void> {
  const updates = req.body as UpdateProfileInput;
  const user = req.user!;

  if (updates.name !== undefined) user.name = updates.name;
  if (updates.bio !== undefined) user.bio = updates.bio;
  if (updates.headline !== undefined) user.headline = updates.headline;
  if (updates.avatarUrl !== undefined) user.avatarUrl = updates.avatarUrl || undefined;
  if (updates.websiteUrl !== undefined) user.websiteUrl = updates.websiteUrl;

  await user.save();

  res.json({ success: true, data: toAuthenticatedUser(user) });
}
