import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import LoginPage from './LoginPage';

vi.mock('../api', () => ({
  login:           vi.fn(),
  fetchLoginTeams: vi.fn(() => Promise.resolve([])),
}));

import * as api from '../api';

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchLoginTeams.mockResolvedValue([]);
  });

  it('renders the HybridSync brand', () => {
    render(<LoginPage onLogin={() => {}} />);
    expect(screen.getByText('HybridSync')).toBeInTheDocument();
  });

  it('renders HR and Manager role buttons', () => {
    render(<LoginPage onLogin={() => {}} />);
    expect(screen.getByText('🏢 HR Admin')).toBeInTheDocument();
    expect(screen.getByText('👥 Team Manager')).toBeInTheDocument();
  });

  it('renders a password field', () => {
    render(<LoginPage onLogin={() => {}} />);
    expect(screen.getByPlaceholderText('Enter password')).toBeInTheDocument();
  });

  it('renders a Sign In button', () => {
    render(<LoginPage onLogin={() => {}} />);
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('shows an error message on failed login', async () => {
    api.login.mockRejectedValueOnce(new Error('Invalid password'));
    render(<LoginPage onLogin={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('Enter password'), {
      target: { value: 'wrongpass' },
    });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText('Invalid password')).toBeInTheDocument();
    });
  });

  it('calls onLogin with role data on successful login', async () => {
    const onLogin = vi.fn();
    api.login.mockResolvedValueOnce({ token: 'tok', role: 'hr', name: 'HR Admin' });

    render(<LoginPage onLogin={onLogin} />);
    fireEvent.change(screen.getByPlaceholderText('Enter password'), {
      target: { value: 'hr@hybridsync' },
    });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(onLogin).toHaveBeenCalledWith({ role: 'hr', teamId: undefined, name: 'HR Admin' });
    });
  });

  it('does not show default password hints', () => {
    render(<LoginPage onLogin={() => {}} />);
    expect(screen.queryByText(/hr@hybridsync/)).toBeNull();
    expect(screen.queryByText(/manager@hybridsync/)).toBeNull();
  });
});
