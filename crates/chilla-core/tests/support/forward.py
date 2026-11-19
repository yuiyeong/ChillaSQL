"""test용 터널. 127.0.0.1:<listen_port>로 받은 연결을 127.0.0.1:<target_port>로 잇는다.

사용: forward.py <listen_port> <target_port> <pid_file>
시작하면 자기 pid를 <pid_file>에 쓴 뒤 포트를 연다.
"""

import os
import socket
import sys
import threading


def pipe(source, sink):
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            sink.sendall(data)
    except OSError:
        pass
    finally:
        for s in (source, sink):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def handle(client, target_port):
    try:
        target = socket.create_connection(("127.0.0.1", target_port))
    except OSError:
        client.close()
        return
    threading.Thread(target=pipe, args=(client, target), daemon=True).start()
    threading.Thread(target=pipe, args=(target, client), daemon=True).start()


def main():
    listen_port, target_port, pid_file = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
    with open(pid_file, "w") as f:
        f.write(str(os.getpid()))
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", listen_port))
    server.listen(16)
    while True:
        client, _ = server.accept()
        threading.Thread(target=handle, args=(client, target_port), daemon=True).start()


main()
