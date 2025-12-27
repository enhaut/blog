---
title: "forwarding performance: xdp-forward vs kernel stack"
date: 2025-12-27
draft: false
description: "Benchmarking `xdp-forward` (and so, `XDP_REDIRECT`) in terms of forwarding, against the standard Linux kernel stack: analyzing massive performance gains (up to 3.8x), isolating scaling bottlenecks, and implementing missing VLAN support."
tags: ["XDP", "kernel", "networking", "performance"]
categories: ["articles"]
---


{{< tldr >}}
`xdp-forward` delivers a raw speed advantage of 2.4x to 3.8x over the standard kernel
stack, though the exact gain depends heavily on the hardware. On x86, the Intel `ice`
driver dominates Mellanox `mlx5` (4.1 vs 2.6 Mpps), but this lead vanishes on ARM
architectures.

Multi-core scaling tests reveal the kernel choking on `qdisc` lock contention,
whereas XDP scales linearly, bounded primarily by the cost of FIB lookups.

Packet size analysis exposes distinct hardware traits masked by the kernel's CPU
overhead: `ice` peaks with small packets, while `mlx5` prefers medium sizes.

Finally, the newly implemented VLAN support eliminates the performance cliff for tagged
traffic, ensuring it stays in the fast path and matches untagged forwarding speeds.
{{< /tldr >}}


## What, how and why

Let's be real. The Linux networking stack is built like a tank -- indestructible and robust,
feature-packed, and absolutely terrible for {{< hover-img "https://platform.vox.com/wp-content/uploads/sites/2/chorus/uploads/chorus_asset/file/14744394/470551215.0.1412314064.jpg?quality=90&strip=all&crop=0%2C27.777777777778%2C100%2C44.444444444444&w=1440" >}}drag{{< /hover-img >}}{{< hover-img "/images/drag_racing.png" "37%" >}} racing{{< /hover-img >}}.
As part of my [Master's thesis](https://www.vut.cz/en/students/final-thesis/detail/164490),
the performance and functional implications of bypassing this machinery were quantified
by benchmarking [xdp-forward](https://github.com/xdp-project/xdp-tools/tree/main/xdp-forward)
against the standard kernel path.

![An illustration of most interesting/important parts of kernel networking stack.](/posts/kernel-vs-xdp-forwarding/images/stack-diagram.svg)

The diagram above makes it clear. The standard path is a bureaucratic nightmare of `sk_buff`
allocations, going through taps and Netfilter hooks, conntrack lookups and the actual routing
and forwarding.

XDP cuts the line. As shown in the image, xdp-forward operates directly within the ingress
interface driver. The packet is snatched hot off the DMA before the kernel even realizes
it has arrived, a lookup is performed, and it's either redirected or delivered locally.

It's a massive shortcut, but it comes with a cost. By bypassing the stack, you literally
_bypass the stack_. Raw performance is gained, but features are left behind.
It's fast, dangerous, and exactly what is tested here.

## Test setup
First things first: the software. The numbers were measured on `kernel-6.12.0-55.3.1.el10_0`.
Yes, it's a bit older[^1]. But the results on the latest kernel are expected to look more
or less identical.

For the physical layout, see the diagram below. It's a classic three-point setup
squeezed into two physical hosts. Host 1 pulls double duty: it generates 64B UDP packets
using `pktgen` (Generator NS) and counts successfully forwarded packets (Receiver NS)[^2].
Host 2 is forwarder running `xdp-forward`. It receives packets on one interface, routes
and forwards them out the other, using either the standard kernel stack or `xdp-forward`.

![HW and SW setup used in tests](/posts/kernel-vs-xdp-forwarding/images/test_case.svg)

Since XDP performance is tied to the specific driver implementation,
testing wasn't limited to just one golden sample. Experiments were run across different
architectures and NICs to get a broader picture. Here is the hardware roster:

| Processor | Sockets | CPUs | NIC | Alias |
| :--- | :--- | :--- | :--- | :--- |
| Intel Xeon 6438N @ 2.0GHz | 2 | 32 | MT2910 [CX-7]<br>Intel E810-XXV | Intel1, mlx5<br>Intel1, ice |
| AMD 7443P @ 2.8GHz | 1 | 24 | BCM57508 | AMD, bnxt_en |
| ARM Altra Q80-30 @ 3.0GHz | 1 | 80 | MT2894 [CX-6]<br>Intel E810-C | ARM, mlx5<br>ARM, ice |
| Intel Xeon 5520+ @ 2.2GHz | 2 | 56 | Solarflare SFC9250 | Intel2, sfc |


To setup test environment, the LNST framework was used[^3]. Depending on test case,
various recipe configurations were used[^4].


## Results

{{< note >}}
The following results highlight significant performance discrepancies
between different architectures and driver implementations. Rather than jumping
to conclusions based on assumptions and results, I plan to dig deeper in future
posts to isolate the root cause of these performance differences.
{{< /note >}}

For more detailed results in table overview as well as
test cases not included in this blog post, see the [thesis](https://www.vut.cz/en/students/final-thesis/detail/164490).

### Single stream

This is the baseline: one core, one flow, max speed.

{{< plotly >}}

{{< include-html "posts/kernel-vs-xdp-forwarding/plots/single_stream.html" >}}

Yooo, that's fast!

On x86 (**Intel1**), the `ice` driver pushes roughly **4.1 Mpps**, leaving
the `mlx5` behind at **2.6 Mpps**. That’s a significant gap on the same hardware.
However, moving to **ARM**, the story changes. The performance delta between
`ice` (~1.7 Mpps) and `mlx5` (~1.5 Mpps) is much narrower.

Solarflare (`sfc`) trails the pack at around **1.2 Mpps**. Which is, to be honest,
dissapointing?


### Packet size scaling

To see how the systems handle different payloads, for various packet
size testing the standard [RFC 2544](https://www.ietf.org/rfc/rfc2544.txt) was respected.

{{< include-html "posts/kernel-vs-xdp-forwarding/plots/packet_size_scaling.html" >}}
{{< warning >}}
NIC used in `Intel1, ice` setup is 25G and results are heavily affected by that.
On a 100G card, this curve might have looked different.
{{< /warning >}}

The kernel results (blue lines) are predictably boring. Performance is virtually
flat at **~1.1-1.3 Mpps** regardless of packet size. This confirms what would be
expected: the standard path is so CPU bound that the overhead of processing headers
outweighs the cost of moving the actual data.

XDP, however, exposes the drivers'/HW's preferences:

* `ice` - Starts strong with a peak of **4.13 Mpps** at 64 bytes but drops off as packets get larger.
* `mlx5` - Shows an inverted pattern. It actually prefers medium chunks, starting at 2.6 Mpps for small packets but climbing to **3.4 Mpps** for 256-1024 byte frames.

The takeaway is clear: Kernel forwarding masks hardware differences under a blanket of CPU overhead. XDP strips that blanket away, exposing exactly how your hardware and driver handle the load.

### Multi stream

Scaling to multiple cores is where things usually break. To test this, traffic was generated
from a single source but targeted multiple destination tuples, pinning each
flow to a specific CPU core using hardware steering. These numbers were collected
on the **Intel1, mlx5** setup.

{{< include-html "posts/kernel-vs-xdp-forwarding/plots/multi_stream.html" >}}

The total throughput (the bars) scales nearly linearly, which is what we want to see.
But if you look closely at the per-stream performance (the lines), you'll notice
a gradual decline as we add more cores:

* XDP - Drops from **~2.6 Mpps** (1 core) to **~2.0 Mpps** per stream (22 cores).
* Kernel - Slides from **~1.1 Mpps** to **~0.7 Mpps** per stream.

Why the drop? For the kernel, the primary culprit is `qdisc` locking. As concurrency
increases, contention for queue locks eats into individual core performance. A future post
will be dedicated to analyzing exactly how much `qdisc` (and other locks)
hurt scaling, but for now, it's the clear bottleneck. For now, see
[flamegraph for kernel](#kernel-forwarding-flame-graph).

### Kernel forwarding flame graph

To pinpoint exactly where the kernel chokes under load, a flame graph was captured
during the 22-stream test (with Fedora's default qdisc `fq_codel` (mq) with standard
netfilter enabled but no rules).

[![Aggregated kernel forwarding flamegraph. 22 flows, each pinned to its own CPU. (Click to open large.)](/posts/kernel-vs-xdp-forwarding/images/mlx5_22cpus_kernel_agg.svg)](/posts/kernel-vs-xdp-forwarding/images/mlx5_22cpus_kernel_agg.svg)

Approximately **49%** of total CPU time is burned inside `__dev_queue_xmit`,
specifically spinning on `_raw_spin_lock`. 


### xdp-forward flame graph


To compare apples to apples, the same recipe configuration was run for `xdp-forward`.

[![Aggregated `xdp-forward` forwarding flamegraph. 22 flows, each pinned to its own CPU. (Click to open large.)](/posts/kernel-vs-xdp-forwarding/images/mlx5_22cpus_xdp_agg.svg)](/posts/kernel-vs-xdp-forwarding/images/mlx5_22cpus_xdp_agg.svg)

Here is where it gets interesting. The single biggest consumer of CPU time isn't
moving packets—it's deciding where they go. The FIB lookup (`bpf_xdp_fib_lookup`)
eats up **~26%** of execution time.

By comparison, the actual packet redirection logic (`xdp_do_redirect`) _only_
takes about **21%**.
_More time is literally spent looking at the map than driving the car._


This validates XDP's zero-copy promise—once the packet lands, no cycles are wasted
shuffling memory around.


## VLAN extension for xdp-forward

### Implementation

One of the biggest functional gaps encountered with `xdp-forward` was the lack of 802.1Q VLAN
support. The issue is fundamental: when `bpf_fib_lookup` decides a packet needs to go
out a VLAN interface (say, `vlan100`), it returns the interface index of that *virtual*
device. But XDP operates at the driver level; it needs the *physical* interface index
(e.g., `eth0`) and the correct VLAN ID to tag the frame before shoving it out the door.

To fix this, the logic shown below was implemented to handle all permutations of tagging:
stripping tags from incoming packets, adding tags for outgoing ones, or swapping tags
when routing between VLANs.

![VLAN Logic flow](/posts/kernel-vs-xdp-forwarding/images/VLAN_parsing.svg)

Two distinct ways were implemented to handle the translation from virtual index to
physical reality:

1. The Userspace Solution - This is the "compatibility mode" version. A userspace map propagates a mapping of `virtual_ifindex` → `(physical_ifindex, vlan_id)` to the BPF program. When the FIB lookup returns a virtual index, the XDP program checks this map to find the actual hardware destination. The catch? Since the map is populated when the program loads, `xdp-forward` has to be reloaded whenever the VLAN configuration changes. But let's be honest—how often are core routers re-cabled?
2. The Kernel Patch Solution - The cleaner, long-term fix. Toke Høiland-Jørgensen wrote a kernel patch that modifies `bpf_fib_lookup` to return the physical interface index and VLAN ID directly.

You can check out the full implementation in the upstream PR: [xdp-project/xdp-tools#504](https://github.com/xdp-project/xdp-tools/pull/504).

### Performance impact

The benchmarks were run across four scenarios: standard traffic (No VLANs), and three
permutations of tagging (Tagged-to-Tagged, Untagged-to-Tagged, Tagged-to-Untagged)[^5].

{{< include-html "posts/kernel-vs-xdp-forwarding/plots/vlans.html" >}}

The baseline performance without VLAN support is bad. The unmodified `xdp-forward`
degrades to **0.82x** the speed of the standard kernel stack when handling VLAN traffic.
This happens because the XDP program runs for every single packet, parses the Ethernet
header, and hits a wall when it sees a VLAN tag instead of an IP header[^6].
It then punts the packet to the stack via `XDP_PASS`. You end up paying the cost of
the XDP execution *plus* the full cost of the kernel stack.

Both of our extensions fix this, restoring the massive XDP performance advantage:

* Userspace Solution - Achieves **2.26x - 2.45x** kernel performance.
* Kernel Patch Solution - Slightly faster, hitting **2.32x - 2.52x** kernel performance.

The kernel patch solution wins by a small margin (2-8%) because it avoids the extra map
lookup required by the userspace implementation. Even for standard non-VLAN traffic,
the overhead of the extra logic is minimal—the kernel patch solution maintains **2.32x**
performance compared to the **2.37x** baseline.

{{< note >}}
This is my first ever blog post! If you have any questions, feedback, or just want
to tell me I'm wrong, feel free to reach out. You can find my email in the commit
logs of the [enhaut/blog](https://github.com/enhaut/blog/) repository.
{{< /note >}}

[^1]: Been super busy being productive, no chance I've been lazy.
[^2]: Actually, for each received packet by `receiver` counter is updated and packet is dropped by XDP. Packets are not passed to kernel stack at all. For multi stream tests there are Mpps and passing it higher just to let kernel drop it is waste of resources.
[^3]: Using `ForwardingRecipe` and `XDPForwardingRecipe`.
[^4]: These can be found in [enhaut/kernel-vs-xdp-forwarding](https://github.com/enhaut/kernel-vs-xdp-forwarding/) repository.
[^5]: E.g. traffic from vlan-tagged generated towards vlan-tagged network is column Tagged to Tagged.
[^6]: After the ethernet frame header, the parser checks `eth->h_proto`. It expects `ETH_P_IP` or `ETH_P_IPV6`, but finds `ETH_P_8021Q` and bails out.
