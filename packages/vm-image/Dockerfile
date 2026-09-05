# Guest Linux image for v86: i386 Alpine + Node.js/npm, packaged for the
# virtio-9p rootfs (not a disk image — v86 boots this directly from a flat
# file tree + JSON manifest produced by fs2json.py/copy-to-sha256.py).
#
# Based on v86's own reference recipe: tools/docker/alpine/Dockerfile in
# https://github.com/copy/v86 (fetched 2026-09-05), extended with nodejs/npm
# per the plan (Phase 1: "Alpine base + apk add nodejs npm").
FROM docker.io/i386/alpine:3.21.0

ENV KERNEL=virt
ENV ADDPKGS="nodejs npm"

RUN apk add openrc alpine-base agetty alpine-conf linux-$KERNEL linux-firmware-none $ADDPKGS

RUN sed -i 's/getty 38400 tty1/agetty --autologin root tty1 linux/' /etc/inittab
RUN echo 'ttyS0::respawn:/sbin/agetty --autologin root -s ttyS0 115200 vt100' >> /etc/inittab
RUN echo "root:" | chpasswd

RUN setup-hostname v86-linux

RUN echo -e "rmmod ne2k-pci && modprobe ne2k-pci\nrmmod virtio-net && modprobe virtio-net\nhwclock -s\nsetup-interfaces -a -r" > /root/networking.sh && chmod +x /root/networking.sh

# https://wiki.alpinelinux.org/wiki/Alpine_Linux_in_a_chroot#Preparing_init_services
RUN for i in devfs dmesg mdev hwdrivers; do rc-update add $i sysinit; done
RUN for i in hwclock modules sysctl hostname syslog bootmisc; do rc-update add $i boot; done
RUN rc-update add killprocs shutdown

# 9p + virtio modules baked into the initramfs so the guest can mount its own
# rootfs over virtio-9p (see docs/linux-9p-image.md upstream).
RUN mkinitfs -F "base virtio 9p" $(cat /usr/share/kernel/$KERNEL/kernel.release)
