//go:build !windows

package daemon

import (
	"os/exec"
	"syscall"
)

func spawnDetached(bin string, args ...string) error {
	cmd := exec.Command(bin, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
