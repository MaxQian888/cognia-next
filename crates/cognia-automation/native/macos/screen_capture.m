#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct CogniaSCCaptureResult {
    uint8_t *bytes;
    size_t length;
    uint32_t width;
    uint32_t height;
    uint32_t window_id;
    uint32_t display_id;
    double logical_x;
    double logical_y;
    double logical_width;
    double logical_height;
    double point_pixel_scale;
    char *error;
} CogniaSCCaptureResult;

static void cognia_sc_set_error(CogniaSCCaptureResult *result, NSString *message) {
    const char *utf8 = message.UTF8String;
    result->error = strdup(utf8 != NULL ? utf8 : "ScreenCaptureKit failed");
}

static bool cognia_sc_require_supported_os(CogniaSCCaptureResult *result) {
    NSOperatingSystemVersion minimum = {
        .majorVersion = 14,
        .minorVersion = 4,
        .patchVersion = 0,
    };
    if (![NSProcessInfo.processInfo isOperatingSystemAtLeastVersion:minimum]) {
        cognia_sc_set_error(result, @"Computer Use requires macOS 14.4 or newer");
        return false;
    }
    return true;
}

static bool cognia_rect_matches(CGRect actual, CGRect expected) {
    const double tolerance = 2.0;
    return fabs(actual.origin.x - expected.origin.x) <= tolerance &&
           fabs(actual.origin.y - expected.origin.y) <= tolerance &&
           fabs(actual.size.width - expected.size.width) <= tolerance &&
           fabs(actual.size.height - expected.size.height) <= tolerance;
}

static double cognia_intersection_area(CGRect lhs, CGRect rhs) {
    CGRect intersection = CGRectIntersection(lhs, rhs);
    if (CGRectIsNull(intersection) || CGRectIsEmpty(intersection)) {
        return 0.0;
    }
    return intersection.size.width * intersection.size.height;
}

static bool cognia_capture_filter(SCContentFilter *filter,
                                  CGRect logical_frame,
                                  bool has_source_rect,
                                  CGRect source_rect,
                                  uint32_t window_id,
                                  uint32_t display_id,
                                  CogniaSCCaptureResult *result) {
    const double scale = MAX((double)filter.pointPixelScale, 1.0);
    SCStreamConfiguration *configuration = [[SCStreamConfiguration alloc] init];
    configuration.width =
        (size_t)MAX(1.0, round(logical_frame.size.width * scale));
    configuration.height =
        (size_t)MAX(1.0, round(logical_frame.size.height * scale));
    configuration.scalesToFit = YES;
    configuration.preservesAspectRatio = YES;
    configuration.showsCursor = YES;
    configuration.ignoreShadowsSingleWindow = YES;
    if (has_source_rect) {
        configuration.sourceRect = source_rect;
    }

    __block NSData *captured_png = nil;
    __block uint32_t captured_width = 0;
    __block uint32_t captured_height = 0;
    __block NSError *capture_error = nil;
    dispatch_semaphore_t capture_ready = dispatch_semaphore_create(0);
    [SCScreenshotManager
        captureImageWithFilter:filter
                 configuration:configuration
             completionHandler:^(CGImageRef image, NSError *error) {
               if (image != NULL) {
                   NSMutableData *png = [NSMutableData data];
                   CGImageDestinationRef destination =
                       CGImageDestinationCreateWithData(
                           (__bridge CFMutableDataRef)png,
                           CFSTR("public.png"),
                           1,
                           NULL);
                   if (destination != NULL) {
                       CGImageDestinationAddImage(destination, image, NULL);
                       if (CGImageDestinationFinalize(destination) && png.length > 0) {
                           captured_png = [png copy];
                           captured_width = (uint32_t)CGImageGetWidth(image);
                           captured_height = (uint32_t)CGImageGetHeight(image);
                       }
                       CFRelease(destination);
                   }
               }
               capture_error = error;
               dispatch_semaphore_signal(capture_ready);
             }];
    if (dispatch_semaphore_wait(
            capture_ready,
            dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0) {
        cognia_sc_set_error(result, @"ScreenCaptureKit screenshot timed out");
        return false;
    }
    if (capture_error != nil || captured_png == nil) {
        cognia_sc_set_error(
            result,
            capture_error.localizedDescription ?:
                @"ScreenCaptureKit returned no encodable screenshot image");
        return false;
    }

    result->bytes = malloc(captured_png.length);
    if (result->bytes == NULL) {
        cognia_sc_set_error(result, @"Unable to allocate screenshot buffer");
        return false;
    }
    memcpy(result->bytes, captured_png.bytes, captured_png.length);
    result->length = captured_png.length;
    result->width = captured_width;
    result->height = captured_height;
    result->window_id = window_id;
    result->display_id = display_id;
    result->logical_x = logical_frame.origin.x;
    result->logical_y = logical_frame.origin.y;
    result->logical_width = logical_frame.size.width;
    result->logical_height = logical_frame.size.height;
    result->point_pixel_scale = scale;
    return true;
}

bool cognia_sc_capture_window(int32_t process_id,
                              const char *preferred_title,
                              bool has_bounds,
                              double logical_x,
                              double logical_y,
                              double logical_width,
                              double logical_height,
                              CogniaSCCaptureResult *result) {
    if (result == NULL) {
        return false;
    }
    memset(result, 0, sizeof(*result));

    @autoreleasepool {
        if (!cognia_sc_require_supported_os(result)) {
            return false;
        }

        __block SCShareableContent *shareable_content = nil;
        __block NSError *content_error = nil;
        dispatch_semaphore_t content_ready = dispatch_semaphore_create(0);
        [SCShareableContent
            getShareableContentExcludingDesktopWindows:YES
                                  onScreenWindowsOnly:NO
                                     completionHandler:^(SCShareableContent *content,
                                                         NSError *error) {
                                       shareable_content = content;
                                       content_error = error;
                                       dispatch_semaphore_signal(content_ready);
                                     }];
        if (dispatch_semaphore_wait(
                content_ready,
                dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0) {
            cognia_sc_set_error(result, @"ScreenCaptureKit window enumeration timed out");
            return false;
        }
        if (content_error != nil || shareable_content == nil) {
            cognia_sc_set_error(
                result,
                content_error.localizedDescription ?:
                    @"ScreenCaptureKit did not return shareable content");
            return false;
        }

        NSString *title_hint =
            preferred_title != NULL && preferred_title[0] != '\0'
                ? [NSString stringWithUTF8String:preferred_title]
                : nil;
        CGRect bounds_hint =
            CGRectMake(logical_x, logical_y, logical_width, logical_height);
        NSMutableArray<SCWindow *> *owned_windows = [NSMutableArray array];
        for (SCWindow *window in shareable_content.windows) {
            if (window.owningApplication.processID == process_id &&
                window.windowLayer == 0 &&
                window.frame.size.width > 0.0 &&
                window.frame.size.height > 0.0) {
                [owned_windows addObject:window];
            }
        }
        if (owned_windows.count == 0) {
            cognia_sc_set_error(
                result,
                @"No capturable ScreenCaptureKit window matched the AX application");
            return false;
        }

        SCWindow *selected = nil;
        NSInteger selected_score = NSIntegerMin;
        bool ambiguous = false;
        for (SCWindow *window in owned_windows) {
            bool title_matches =
                title_hint != nil && window.title != nil &&
                [window.title isEqualToString:title_hint];
            bool bounds_match = has_bounds &&
                                cognia_rect_matches(window.frame, bounds_hint);
            if ((title_hint != nil || has_bounds) &&
                !title_matches && !bounds_match) {
                continue;
            }
            NSInteger score = 0;
            if (bounds_match) {
                score += 1000;
            }
            if (title_matches) {
                score += 100;
            }
            if (window.isActive) {
                score += 10;
            }
            if (window.isOnScreen) {
                score += 5;
            }
            if (score > selected_score) {
                selected = window;
                selected_score = score;
                ambiguous = false;
            } else if (score == selected_score) {
                ambiguous = true;
            }
        }
        if (selected == nil) {
            cognia_sc_set_error(
                result,
                @"AX window metadata did not match a ScreenCaptureKit window");
            return false;
        }
        if (ambiguous) {
            cognia_sc_set_error(
                result,
                @"Multiple ScreenCaptureKit windows matched the AX window metadata");
            return false;
        }

        SCContentFilter *filter =
            [[SCContentFilter alloc] initWithDesktopIndependentWindow:selected];

        uint32_t display_id = 0;
        double largest_display_overlap = 0.0;
        for (SCDisplay *display in shareable_content.displays) {
            double overlap = cognia_intersection_area(selected.frame, display.frame);
            if (overlap > largest_display_overlap) {
                largest_display_overlap = overlap;
                display_id = display.displayID;
            }
        }
        return cognia_capture_filter(
            filter,
            selected.frame,
            false,
            CGRectZero,
            selected.windowID,
            display_id,
            result);
    }
}

bool cognia_sc_capture_display(uint32_t requested_display_id,
                               bool has_region,
                               double region_x,
                               double region_y,
                               double region_width,
                               double region_height,
                               CogniaSCCaptureResult *result) {
    if (result == NULL) {
        return false;
    }
    memset(result, 0, sizeof(*result));

    @autoreleasepool {
        if (!cognia_sc_require_supported_os(result)) {
            return false;
        }
        __block SCShareableContent *shareable_content = nil;
        __block NSError *content_error = nil;
        dispatch_semaphore_t content_ready = dispatch_semaphore_create(0);
        [SCShareableContent
            getShareableContentExcludingDesktopWindows:NO
                                  onScreenWindowsOnly:NO
                                     completionHandler:^(SCShareableContent *content,
                                                         NSError *error) {
                                       shareable_content = content;
                                       content_error = error;
                                       dispatch_semaphore_signal(content_ready);
                                     }];
        if (dispatch_semaphore_wait(
                content_ready,
                dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0) {
            cognia_sc_set_error(result, @"ScreenCaptureKit display enumeration timed out");
            return false;
        }
        if (content_error != nil || shareable_content == nil) {
            cognia_sc_set_error(
                result,
                content_error.localizedDescription ?:
                    @"ScreenCaptureKit did not return display content");
            return false;
        }

        CGRect requested_region =
            CGRectMake(region_x, region_y, region_width, region_height);
        uint32_t display_id = requested_display_id;
        if (display_id == 0 && has_region) {
            CGPoint center = CGPointMake(
                CGRectGetMidX(requested_region),
                CGRectGetMidY(requested_region));
            for (SCDisplay *display in shareable_content.displays) {
                if (CGRectContainsPoint(display.frame, center)) {
                    display_id = display.displayID;
                    break;
                }
            }
        }
        if (display_id == 0) {
            display_id = CGMainDisplayID();
        }
        SCDisplay *selected = nil;
        for (SCDisplay *display in shareable_content.displays) {
            if (display.displayID == display_id) {
                selected = display;
                break;
            }
        }
        if (selected == nil) {
            cognia_sc_set_error(result, @"Requested ScreenCaptureKit display is unavailable");
            return false;
        }
        SCContentFilter *filter =
            [[SCContentFilter alloc] initWithDisplay:selected excludingWindows:@[]];
        CGRect logical_frame = selected.frame;
        CGRect local_source_rect = CGRectZero;
        if (has_region) {
            logical_frame = CGRectIntersection(requested_region, selected.frame);
            if (CGRectIsNull(logical_frame) || CGRectIsEmpty(logical_frame)) {
                cognia_sc_set_error(
                    result,
                    @"Requested screenshot region does not intersect the selected display");
                return false;
            }
            local_source_rect = CGRectMake(
                logical_frame.origin.x - selected.frame.origin.x,
                logical_frame.origin.y - selected.frame.origin.y,
                logical_frame.size.width,
                logical_frame.size.height);
        }
        return cognia_capture_filter(
            filter,
            logical_frame,
            has_region,
            local_source_rect,
            0,
            selected.displayID,
            result);
    }
}

void cognia_sc_capture_result_free(CogniaSCCaptureResult *result) {
    if (result == NULL) {
        return;
    }
    free(result->bytes);
    free(result->error);
    memset(result, 0, sizeof(*result));
}
