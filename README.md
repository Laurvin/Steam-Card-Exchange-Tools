# Steam-Card-Exchange-Tools
This userscript adds a number of features to the Watchlist and Inventory pages of the Steam Card Exchange (SCE) website and to any Steam Trades started by the buttons this tool adds. Most new features contain a help text if hovered over. See the [SCE website](https://www.steamcardexchange.net/) for more information on how the site works.

The three most useful features are new trade buttons for quicker and easier trades, a button to calculate what booster packs are best to create with gems if used to sell the cards for credits to SCE, and a way to sync the user's actual inventory of Steam Trading Cards with the SCE Watchlist. These features work independently from each other.

![Screenshot](https://raw.githubusercontent.com/Laurvin/Steam-Card-Exchange-Tools/refs/heads/master/SCE%20Tools.png)

## On Page Load
These tools only work if the table is loaded fully on the page and not split in 20 row chunks as SCE sets it by default. Thus on loading the page we make changes to the table. This will take a number of seconds for the Inventory page (and will only get slower as more games with cards are added to Steam).

The Sets Available column is changed to a Set Worth (S W) column that shows the number of credits needed for a full set of cards. The table is then sorted on this column and filtered on All games / Green games only. The default sort order and filter for both pages can be set separately via Settings.

A new column, Trade Buttons (T B), is added, see below.

The SCE Toggles (for showing only certain card types) above the table are hidden because using these will mess up the new table. A new button is added to filter between All Games and Green Games (Normal Price Games).

An SCE Tools button is added, click it to open a Settings modal.

## Sync Watchlist
This function will load the user's Steam Inventory via the Steam API and will then compare the games currently in the Watchlist with the games the user currently has cards of and then add the games missing to the Watchlist and remove games from the Watchlist that the user no longer has any cards of.

Note that to be able to load the Steam Inventory the user needs to be logged into the Steam Community in the browser they are using SCE and this script. The most safe way is to first open the [Steam Inventory](https://steamcommunity.com/my/inventory/) or another [Steam Community](https://steamcommunity.com/my/) page in the browser, make sure to be logged into it (name and profile pic at the top right of the page are visible) and then open the SCE page.

Also note that possibly Steam might consider getting the inventory via the API while at the same loading information for the trade buttons (see below) to be not respecting the rate-limit. So it might be safer to sync after the buttons have loaded.

After syncing, the script will add four new columns to the table that can all be sorted on. It also resorts the table on the Set Worth (S W) and Cards Needed columns. and sets the filter to only Green games.

The columns added are Cards Owned (C O), Possible Badges (P B), Cards Needed (C N), and Cards Remaining (C R). Hover over each column header for more information. In short: the columns show how many badges can currently be created based by the number of cards owned (it doesn't show if exactly one of each is owned or if trading might be needed, the buttons, see below, handle some of that), the cards currently owned, how many are needed to create a badge, and how many cards will remain if a badge was to be created right now. If the number in the Cards Needed column is 3 or lower it will be colored orange to red to make them stand out.

Note: these four columns are calculated from a user's total card count per game only (not which specific cards they own), so they can occasionally disagree with what a B/L/S button shows for the same game — the buttons use more precise, live per-card data. The columns are fast and cover the whole Watchlist at once; the buttons are exact but only computed for a limited number of games at a time.

After synching the Sync button changes into a button to show/hide the sync information.

Everything in this section only works on the Watchlist page.

## Trade Buttons
The script adds Sell (S), Buy (B), and Limited Buy (L) buttons to the SCE Watchlist and Inventory pages in their own column. The buttons are placed in the table once it has been restructured on page load. It then gets information from both SCE and Steam to offer all the information needed and to be able to start the best possible trade for the game in its row.

Getting this information is rate limited, the buttons will populate with information about one per second, that's why only a select number of games (the cheapest and most expensive by Set Worth) get these buttons, Settings has inputs to change the default numbers.

It is highly suggested to have Purchase of Last Cards set to Disabled on the SCE Profile.

Trades can be opened in a new tab or window and after a successful trade the tab or window can be closed automatically or the OK button can be clicked automatically so Steam loads the Sent Offers page. This can all be configured under Settings.

### Sell Button
Clicking a Sell button will start a trade with SCE to trade cards away for credits. On page load it gets the current credits amount from the SCE page (top right) and uses this information to make it so that the button will never create a trade that will trade away more cards than SCE will accept for credits (the max is 100).

It also looks at the SCE game page and makes it so it will never try to sell a card that would put SCE over the max stock (8) for that card.

Other than the above limits it will try and sell as many cards as possible, up to the SCE trade limit of 6 cards. It will sell cards SCE has most in stock of first, if possible.

The S button will show how many cards it is selling out of the number of cards owned. So, if we own five cards but can only sell three cards to not get over the 100 credit limit the S button would show "S: 3 of 5".

Hover over an S button to see the total credit value of the trade.

The button will turn red when the games' badge level is 5 and you still have cards.

The button will turn yellow when no trade can be made, either because SCE is at max stock for the cards owned or because the credits would go over the max of 100. Hover over the button to see the exact reason.

Note that because the credit amount is not updated dynamically on the SCE page the S button information is only correct directly after page load. Once cards are sold the user will have to keep track of their current credits, reload the page, or load the SCE Profile page in a new tab.

### Buy Button
This button buys as many cards as possible with these restraints:

* The SCE trade limit of 6.
* Won't buy any last cards in stock at SCE (those cost 1.5 times the normal credits).
* Will try and buy cards in such a way that the number of cards owned for a game will be as balanced as possible (so one of each card is owned instead of six of one).

It will **not** look at the following:

* Current badge level for a game (so it will happily keep buying cards even if more than enough cards to get badge level to 5 are already owned).
* Credits with SCE (otherwise the user would need to reload the page a lot, it's easier to sell from another tab and/or make sure to top up credits first).

The Buy button will show how many cards will be gotten when clicking it and how many different cards are traded between parenthesis. So, if SCE has five copies of card B and four copies of card D, and 1 or less of the other cards, the Buy button would show "B: 6 (2)"; we are getting six cards and those will be from among two unique cards for that game.

Hovering over a Buy button will show more information, including exactly which cards it will try to buy.

The button will turn red if a trade gets more cards than needed to create badge level 5.

The button will turn a darker green if the trade will get a number of cards that allows to create a badge after the trade (meaning that the user has at least one of each card after the trade).

### Limited Buy Button
This button is much the same as the Buy button but it will not get any cards that will put the user over the number needed to create a single badge.

It has the following restraints:

* If already at badge level 5 it will not buy any cards.
* The SCE trade limit of 6.
* Won't buy any last cards in stock at SCE (those cost 1.5 times the normal credits).
* Won't buy more cards than necessary to complete a single badge, taking into account the cards already owned.
* Will try and buy cards in such a way that the number of cards owned for a game will be as balanced as possible (so one of each card is owned instead of six of one).
* If the user has at least a number of cards for a badge but not one of each, when SCE has a card the user is missing and the user owns a duplicate of another card, it will create a trade where the user trades the duplicate for the card not owned. Because trading away a card can't be done via a Quick-Trade (see below), this will always be a regular trade. If no card can be traded back because it's at max stock, the trade will just get the missing card.

Hovering over a Limited Buy button will show more information, including exactly which cards it will try to buy.

The button will turn yellow when no trade is possible, hover over it for more information.

The button will turn bright green if a badge can already be created without trading.

The button will turn a darker green if the trade will get a number of cards that allows to create a badge after the trade (meaning that the user has at least one of each card after the trade).

### Quick-Trades
Steam has a special function for trading for just **a single card** from another user where it puts the specific card in the trade url. SCE uses this functionality, it shows a Quick-Trade button under the cards on their card pages.

These trades work much better than normal trades and work 99% of the time (if a card doesn't load in the item box a reload almost always fixes this). Trades for multiple cards are much less reliable, especially when the servers are under heavy load such as during a Steam Sale.

When a trade would get no more than one copy of each card anyway, the script allows for using Quick-Trades instead of a normal trade. In that case a small yellow Q will be shown in the B and L buttons. When clicked it will open a number of trade tabs equal to the number of cards to be gotten.

Quick-Trades are enabled by default but can be disabled under Settings.

## Booster Values
On the Inventory page a button is added to calculate how many credits one can get per gem spent for a booster pack. When clicked it gets the user's list of owned games and then do its calculations, adding a new Booster Value (B V) column to the table and sorting on it, showing the best options at the top. It also adds a button that links to the [Booster Pack Creator](https://steamcommunity.com/tradingcards/boostercreator/) page.

It uses the following formula to normalize since booster packs always contain 3 cards but games can have between 5 and 15 trading cards: Math.round((worth * 3) / Math.round(6000 / setSize) * 10000).

Note that the user needs to be logged into the [Steam Store](https://store.steampowered.com/) for the script to be able to get the list of owned games. The Steam Store and the Steam Community are not the same so the user should open a tab with it and make sure to be logged into it (name and profile pic at the top right of the page are visible) before opening any SCE page.

Experience learns that if the user does not do this first, it can't be recovered by closing the browser and then opening it again and following the above instructions. Usually it takes up to a day before it works again.

## Blacklist
Any AppIDs entered into the Blacklist under Settings will be ignored by the script when creating buttons. This means they are ignored when calculating the range for the B, L, and S buttons.

Any game blacklisted will get a "BL" indicator in the T B column to indicate it is blacklisted.

## Manually hiding games at Badge level 5
To hide games that are already at the maximum badge level create a userstyle with [Stylus](https://github.com/openstyles/stylus) using the template from [Steam Card Exchange - Badge level 5 highlighter/hider](https://github.com/Laurvin/Steam-Card-Exchange---Badge-level-5-highlighter-hider).

