//go:build windows

package daemon

import (
	"os/exec"
	"syscall"
)

const (
	createNewProcessGroup = 0x00000200
	detachedProcess       = 0x00000008
)

func spawnDetached(bin string, args ...string) error {
	cmd := exec.Command(bin, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNewProcessGroup | detachedProcess,
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
