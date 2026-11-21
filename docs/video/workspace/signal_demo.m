%% Make a noisy signal
t = linspace(0, 1, 500);
x = sin(2*pi*5*t) + 0.3*randn(size(t));

%% Summarise it
fprintf('Mean %.3f, std %.3f\n', mean(x), std(x));
peakValue = max(x)

%% Count samples above a threshold
thr = input('Threshold: ');
fprintf('%d samples above %g\n', nnz(x > thr), thr);
