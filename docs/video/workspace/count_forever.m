% Counts until you press Stop.
n = 0;
while true
    n = n + 1;
    if mod(n, 20) == 0, fprintf('still counting: %d\n', n); end
    pause(0.05);
end
