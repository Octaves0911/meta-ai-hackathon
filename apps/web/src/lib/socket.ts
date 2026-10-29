import { io, type Socket } from 'socket.io-client';

let socket: Socket | null = null;
let current: string | null = null;

/** Single shared connection per signed-in username. */
export function getSocket(username: string): Socket {
  if (!socket || current !== username) {
    socket?.disconnect();
    socket = io({ auth: { username } });
    current = username;
  }
  return socket;
}
