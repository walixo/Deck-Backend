import type { Request, Response } from 'express';
import { User } from '../models/User';
import { toAuthenticatedUser } from '../serializers';
import { ApiError } from '../utils/ApiError';
import { signToken } from '../utils/jwt';
import type {
  ChangePasswordInput,
  LoginInput,
  RegisterInput,
  UpdateProfileInput,
} from '../validators/auth.validators';

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

/**
 * Changes the account's password.
 *
 * `req.user` cannot be used directly: the schema marks `password` as
 * `select: false`, so the document the auth middleware attached has no hash on
 * it and `comparePassword` would compare against undefined — which bcrypt
 * rejects, meaning every attempt would fail with "that is not your current
 * password". Refetching with `+password` is the whole reason this does its own
 * lookup.
 *
 * The new value is assigned in plain text on purpose. The model's pre-save hook
 * hashes anything that changed, so hashing here would store a hash of a hash
 * and lock the account out permanently.
 */
export async function changePassword(req: Request, res: Response): Promise<void> {
  const { currentPassword, newPassword } = req.body as ChangePasswordInput;

  const user = await User.findById(req.user!._id).select('+password');
  if (!user) throw ApiError.unauthorized('Please sign in again');

  const matches = await user.comparePassword(currentPassword);
  if (!matches) throw ApiError.badRequest('That is not your current password');

  user.password = newPassword;
  await user.save();

  /*
   * A fresh token goes back with the response.
   *
   * Not strictly required — Deck's tokens carry only a subject and a username,
   * so the old one keeps working — but reissuing means the client is holding a
   * token minted after the change rather than before it, which is the sane
   * thing to have if session invalidation is ever added.
   */
  res.json({
    success: true,
    data: {
      token: signToken({ sub: user._id.toString(), username: user.username }),
      user: toAuthenticatedUser(user),
    },
  });
}
