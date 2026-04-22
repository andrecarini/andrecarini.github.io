#!/usr/bin/perl
# Tiny static-file dev server. Core-Perl only (no CPAN deps), serves the
# current directory. Used to test the split homepage locally — ES modules
# refuse to load from file:// in most browsers, so the bare double-click
# workflow doesn't cut it.
use strict;
use warnings;
use IO::Socket::INET;

my $port = $ENV{PORT} || 8000;

my $server = IO::Socket::INET->new(
    LocalAddr => '127.0.0.1',
    LocalPort => $port,
    Proto     => 'tcp',
    Listen    => 10,
    ReuseAddr => 1,
) or die "Cannot listen on port $port: $!";

print STDERR "Serving . at http://127.0.0.1:$port/  (Ctrl-C to stop)\n";

my %mime = (
    html => 'text/html; charset=utf-8',
    htm  => 'text/html; charset=utf-8',
    css  => 'text/css; charset=utf-8',
    js   => 'application/javascript; charset=utf-8',
    mjs  => 'application/javascript; charset=utf-8',
    svg  => 'image/svg+xml',
    json => 'application/json',
    png  => 'image/png',
    jpg  => 'image/jpeg',
    jpeg => 'image/jpeg',
    gif  => 'image/gif',
    webp => 'image/webp',
    ico  => 'image/x-icon',
    woff => 'font/woff',
    woff2 => 'font/woff2',
    txt  => 'text/plain; charset=utf-8',
    map  => 'application/json',
);

while (my $client = $server->accept) {
    $client->autoflush(1);
    my $req = <$client>;
    unless (defined $req) { close $client; next; }
    # drain remaining headers
    while (my $hdr = <$client>) { last if $hdr =~ /^\r?\n$/; }

    if ($req =~ m{^GET\s+(\S+)\s+HTTP}) {
        my $path = $1;
        $path =~ s/\?.*$//;
        $path = '/index.html' if $path eq '/';
        # basic traversal guard — strip any ".."
        $path =~ s{\.\.}{}g;
        my $file = ".$path";

        if (-f $file && open(my $fh, '<:raw', $file)) {
            my $ext  = ($file =~ /\.([^.]+)$/) ? lc($1) : '';
            my $ct   = $mime{$ext} // 'application/octet-stream';
            my $size = -s $file;
            print STDERR "[200] $path ($size bytes)\n";
            print $client "HTTP/1.0 200 OK\r\n";
            print $client "Content-Type: $ct\r\n";
            print $client "Content-Length: $size\r\n";
            print $client "Cache-Control: no-cache, no-store, must-revalidate\r\n";
            print $client "Connection: close\r\n";
            print $client "\r\n";
            binmode $client;
            my $buf;
            print $client $buf while read $fh, $buf, 65536;
            close $fh;
        } else {
            my $body = "404 Not Found: $path\n";
            print STDERR "[404] $path\n";
            print $client "HTTP/1.0 404 Not Found\r\n";
            print $client "Content-Type: text/plain; charset=utf-8\r\n";
            print $client "Content-Length: ", length($body), "\r\n";
            print $client "Connection: close\r\n";
            print $client "\r\n";
            print $client $body;
        }
    }

    close $client;
}
